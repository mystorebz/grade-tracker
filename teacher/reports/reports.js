import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { gradeColorClass, letterGrade, downloadCSV } from '../../assets/js/utils.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('reports', 'Query Builder', 'Generate advanced analytics and custom report cards', false);
}

// ── 2. STATE VARIABLES ──────────────────────────────────────────────────────
let allStudentsCache = [];
let studentMap = {};
let rawSemesters = [];
let allGradesCache = null; // Caches { semId, grades[] } to avoid re-fetching same semester
let currentQueryResults = []; 
let currentQueryMeta = {}; 

// Escapes HTML to prevent XSS
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

    // Load Dropdowns
    populateStaticDropdowns();
    await loadSemesters();
    await loadStudents();
}

function populateStaticDropdowns() {
    // Subjects
    const subjects = (session.teacherData.subjects || []);
    const subSel = document.getElementById('rb-subject');
    subSel.innerHTML = '<option value="all">All Subjects (Combined)</option>' + subjects.map(s => `<option value="${escHtml(s.name)}">${escHtml(s.name)}</option>`).join('');

    // Types
    const types = session.teacherData.customGradeTypes || ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
    const typeSel = document.getElementById('rb-type');
    typeSel.innerHTML = '<option value="all">All Assignment Types</option>' + types.map(t => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join('');
}

async function loadSemesters() {
    try {
        const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId = schoolSnap.data()?.activeSemesterId || '';

        rawSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));

        const semSel = document.getElementById('rb-semester');
        semSel.innerHTML = '';
        rawSemesters.forEach(s => {
            semSel.innerHTML += `<option value="${s.id}"${s.id === activeId ? ' selected' : ''}>${escHtml(s.name)}</option>`;
        });
    } catch (e) {
        console.error("[Reports] Error loading semesters:", e);
    }
}

async function loadStudents() {
    try {
        // Fetch ALL students assigned to this teacher (including archived, so historical queries work)
        const stuQuery = query(collection(db, 'schools', session.schoolId, 'students'), where('teacherId', '==', session.teacherId));
        const stuSnap = await getDocs(stuQuery);
        
        allStudentsCache = stuSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        studentMap = {};
        allStudentsCache.forEach(s => { studentMap[s.id] = s.name; });

        const stuSel = document.getElementById('rb-student');
        const sortedStudents = [...allStudentsCache].sort((a, b) => a.name.localeCompare(b.name));
        stuSel.innerHTML = '<option value="">— Target a specific student —</option>' + sortedStudents.map(s => `<option value="${s.id}">${escHtml(s.name)} ${s.archived ? '(Archived)' : ''}</option>`).join('');
    } catch (e) {
        console.error("[Reports] Error loading students:", e);
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

// ── 4. DATA FETCHING ────────────────────────────────────────────────────────
async function fetchGradesForSemester(semId) {
    if (allGradesCache && allGradesCache.semId === semId) return allGradesCache.grades;
    
    const all = [];
    await Promise.all(allStudentsCache.map(async s => {
        try {
            const q = query(collection(db, 'schools', session.schoolId, 'students', s.id, 'grades'), where('semesterId', '==', semId));
            const snap = await getDocs(q);
            snap.forEach(d => all.push({ id: d.id, studentId: s.id, studentName: s.name, ...d.data() }));
        } catch (e) { }
    }));
    
    allGradesCache = { semId, grades: all };
    return all;
}

// ── 5. INTELLIGENT GENERATOR ────────────────────────────────────────────────
// Added a slight delay sequence to give the UI an advanced, analytical feel
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function executeIntelligentQuery() {
    const btn = document.getElementById('generateReportBtn');
    
    const semId = document.getElementById('rb-semester').value;
    const scope = document.getElementById('rb-scope').value;
    const targetStudentId = document.getElementById('rb-student').value;
    const subject = document.getElementById('rb-subject').value;
    const type = document.getElementById('rb-type').value;

    if (scope === 'student' && !targetStudentId) {
        alert("SQL Error: Target student ID required for individual scope.");
        return;
    }

    btn.disabled = true;
    const area = document.getElementById('reportResultsArea');
    area.classList.add('opacity-0');
    
    try {
        btn.innerHTML = `<i class="fa-solid fa-server fa-fade"></i> Querying database...`;
        const rawGrades = await fetchGradesForSemester(semId);
        await sleep(400);

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
        filteredGrades.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        currentQueryResults = filteredGrades;
        await sleep(300);

        btn.innerHTML = `<i class="fa-solid fa-chart-line fa-fade"></i> Calculating aggregates...`;
        
        const semSel = document.getElementById('rb-semester');
        const semName = semSel.options[semSel.selectedIndex]?.text || 'Unknown Period';
        const scopeName = scope === 'class' ? 'Class Overview' : studentMap[targetStudentId];
        const subName = subject === 'all' ? 'All Subjects' : subject;
        const typeName = type === 'all' ? 'All Types' : type;

        currentQueryMeta = { semName, scopeName, subName, typeName, scope, targetStudentId };

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
        await sleep(200);

        // 4. Update UI
        btn.innerHTML = `<i class="fa-solid fa-object-group fa-fade"></i> Rendering interface...`;
        
        document.getElementById('reportOutputTitle').textContent = scope === 'class' ? 'Aggregated Class Data' : 'Student Academic Profile';
        document.getElementById('reportOutputMeta').textContent = `${semName} · ${scopeName} · ${subName}`;

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
                return `
                <tr class="border-b border-[#f0f4f8] hover:bg-[#f8fafb] transition">
                    <td class="px-6 py-4 text-[12px] font-mono text-[#6b84a0]">${g.date || '—'}</td>
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
        alert("Query Execution Failed.");
    }

    btn.innerHTML = `<i class="fa-solid fa-play"></i> Execute Query`;
    btn.disabled = false;
}

// ── 6. EXPORT / PRINT (OFFICIAL REPORT CARD GEN) ────────────────────────────
window.exportReportCSV = function() {
    if (!currentQueryResults || currentQueryResults.length === 0) {
        alert("No data to export.");
        return;
    }
    
    const rows = [['Date', 'Student', 'Subject', 'Assignment', 'Type', 'Score', 'Max', '%', 'Letter Grade', 'Teacher Notes']];
    
    currentQueryResults.forEach(g => {
        const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
        rows.push([
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
        alert("No data to print.");
        return;
    }
    
    const isStudentReport = currentQueryMeta.scope === 'student';
    const reportTitle = isStudentReport ? 'Official Academic Report' : 'Aggregated Class Data';
    
    const printDisclaimer = "<p style='font-size:10px;color:#9ab0c6;margin-top:40px;text-align:center;border-top:1px solid #dce3ed;padding-top:14px;font-style:italic;'>Generated by ConnectUs Analytical Engine. This document does not constitute a certified administrative transcript.</p>";
    
    let html = `<html><head><title>Data Report — ${escHtml(currentQueryMeta.scopeName)}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        body { font-family: 'DM Sans', sans-serif; padding: 40px; color: #0d1f35; line-height: 1.5; background: white; }
        
        .header { display: flex; flex-direction: column; align-items: center; border-bottom: 2px solid #0d1f35; padding-bottom: 20px; margin-bottom: 30px; }
        .logo { max-height: 50px; max-width: 180px; object-fit: contain; margin-bottom: 12px; }
        
        .header h1 { margin: 0 0 4px 0; font-size: 20px; color: #0d1f35; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; }
        .header h2 { margin: 0; font-size: 12px; color: #6b84a0; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; }
        
        .info-grid { background: #f8fafb; padding: 18px; border-radius: 4px; border: 1px solid #dce3ed; margin-bottom: 30px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .info-grid div { font-size: 13px; color: #0d1f35; }
        .info-grid strong { font-size: 10px; color: #6b84a0; text-transform: uppercase; letter-spacing: 0.1em; display: block; margin-bottom: 2px; }
        
        table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
        th, td { border: 1px solid #dce3ed; padding: 10px 14px; text-align: left; font-size: 12px; }
        th { background: #f8fafb; color: #0d1f35; font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; }
        .tc { text-align: center; }
        .font-mono { font-family: 'DM Mono', monospace; font-weight: 700; }
    </style></head><body>
    
    <div class="header">
        <img src="../../assets/images/logo.png" alt="ConnectUs" class="logo" onerror="this.style.display='none'">
        <h1>${reportTitle}</h1>
        <h2>${escHtml(session.teacherData.name)} • ${currentQueryMeta.semName}</h2>
    </div>
    
    <div class="info-grid">
        <div><strong>Target Scope</strong> ${escHtml(currentQueryMeta.scopeName)}</div>
        <div><strong>Subject Filter</strong> ${escHtml(currentQueryMeta.subName)}</div>
        <div><strong>Assignment Type</strong> ${escHtml(currentQueryMeta.typeName)}</div>
        <div><strong>Date Generated</strong> ${new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })}</div>
    </div>
    
    <table>
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
    
    html += `</tbody></table>${printDisclaimer}</body></html>`;
    
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 600);
};

// Fire it up
init();
