import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { gradeColorClass, letterGrade, downloadCSV } from '../../assets/js/utils.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    // Note: If you haven't added a 'reports' link to layout-teachers.js yet, 
    // it will just inject without highlighting a sidebar item. 
    injectTeacherLayout('reports', 'Custom Reports', 'Generate multi-filtered performance data', false);
}

// ── 2. STATE VARIABLES ──────────────────────────────────────────────────────
let allStudentsCache = [];
let studentMap = {};
let rawSemesters = [];
let allGradesCache = null; // Caches { semId, grades[] } to avoid re-fetching same semester
let currentQueryResults = []; // Stores the active table data for exporting
let currentQueryMeta = {}; // Stores the text labels of the current query for the print header

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    // Sidebar Data
    document.getElementById('displayTeacherName').textContent = session.teacherData.name;
    document.getElementById('teacherAvatar').textContent = session.teacherData.name.charAt(0).toUpperCase();
    document.getElementById('sidebarSchoolId').textContent = session.schoolId;

    // Attach Listeners
    document.getElementById('rb-scope').addEventListener('change', toggleScope);
    document.getElementById('generateReportBtn').addEventListener('click', generateReport);

    // Load Dropdowns
    populateStaticDropdowns();
    await loadSemesters();
    await loadStudents();
}

function populateStaticDropdowns() {
    // Subjects
    const subjects = (session.teacherData.subjects || []); // Show all (even archived) so past reports work
    const subSel = document.getElementById('rb-subject');
    subSel.innerHTML = '<option value="all">All Subjects</option>' + subjects.map(s => `<option value="${s.name}">${s.name}</option>`).join('');

    // Types
    const types = session.teacherData.customGradeTypes || ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
    const typeSel = document.getElementById('rb-type');
    typeSel.innerHTML = '<option value="all">All Types</option>' + types.map(t => `<option value="${t}">${t}</option>`).join('');
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
            semSel.innerHTML += `<option value="${s.id}"${s.id === activeId ? ' selected' : ''}>${s.name}</option>`;
        });
    } catch (e) {
        console.error("Error loading semesters:", e);
    }
}

async function loadStudents() {
    try {
        // Fetch ALL students assigned to this teacher (even if archived, so past reports work)
        const stuQuery = query(collection(db, 'schools', session.schoolId, 'students'), where('teacherId', '==', session.teacherId));
        const stuSnap = await getDocs(stuQuery);
        
        allStudentsCache = stuSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        studentMap = {};
        allStudentsCache.forEach(s => { studentMap[s.id] = s.name; });

        // Populate Student Dropdown
        const stuSel = document.getElementById('rb-student');
        
        // Sort alphabetically
        const sortedStudents = [...allStudentsCache].sort((a, b) => a.name.localeCompare(b.name));
        stuSel.innerHTML = '<option value="">— Select a Student —</option>' + sortedStudents.map(s => `<option value="${s.id}">${s.name} ${s.archived ? '(Archived)' : ''}</option>`).join('');
    } catch (e) {
        console.error("Error loading students:", e);
    }
}

function toggleScope() {
    const scope = document.getElementById('rb-scope').value;
    const wrap = document.getElementById('studentFilterWrap');
    if (scope === 'student') {
        wrap.classList.remove('hidden');
    } else {
        wrap.classList.add('hidden');
        document.getElementById('rb-student').value = ''; // clear selection
    }
}

// ── 4. DATA FETCHING ────────────────────────────────────────────────────────
async function fetchGradesForSemester(semId) {
    if (allGradesCache && allGradesCache.semId === semId) return allGradesCache.grades;
    
    const all = [];
    // We iterate over the students in cache to grab their subcollections
    // This is the fastest way without an expensive Collection Group query
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

// ── 5. GENERATE REPORT LOGIC ────────────────────────────────────────────────
async function generateReport() {
    const btn = document.getElementById('generateReportBtn');
    
    // Grab Filters
    const semId = document.getElementById('rb-semester').value;
    const scope = document.getElementById('rb-scope').value;
    const targetStudentId = document.getElementById('rb-student').value;
    const subject = document.getElementById('rb-subject').value;
    const type = document.getElementById('rb-type').value;

    // Validation
    if (scope === 'student' && !targetStudentId) {
        alert("Please select a target student.");
        return;
    }

    // UI Loading state
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing...`;
    btn.disabled = true;

    try {
        // 1. Fetch raw dataset
        const rawGrades = await fetchGradesForSemester(semId);

        // 2. Apply Filters
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

        // Sort by Date (newest first)
        filteredGrades.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        // Save state for export
        currentQueryResults = filteredGrades;

        // Save Meta tags for UI
        const semSel = document.getElementById('rb-semester');
        const semName = semSel.options[semSel.selectedIndex]?.text || 'Unknown Period';
        const scopeName = scope === 'class' ? 'Whole Class' : studentMap[targetStudentId];
        const subName = subject === 'all' ? 'All Subjects' : subject;
        const typeName = type === 'all' ? 'All Types' : type;

        currentQueryMeta = { semName, scopeName, subName, typeName };

        // 3. Calculate Stats
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

        // 4. Update UI - Meta
        document.getElementById('reportOutputTitle').textContent = scope === 'class' ? 'Class Report' : 'Student Report';
        document.getElementById('reportOutputMeta').textContent = `${semName} · ${scopeName} · ${subName} · ${typeName}`;

        // 5. Update UI - Stat Cards
        document.getElementById('resAvg').innerHTML = avg !== null ? `${avg}<span class="text-lg text-slate-400">%</span>` : '—';
        document.getElementById('resHigh').innerHTML = high !== null ? `${high}<span class="text-lg text-emerald-300">%</span>` : '—';
        document.getElementById('resLow').innerHTML = low !== null ? `${low}<span class="text-lg text-rose-300">%</span>` : '—';
        document.getElementById('resCount').textContent = filteredGrades.length;

        // 6. Update UI - Table
        const tbody = document.getElementById('reportTableBody');
        if (filteredGrades.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="px-6 py-12 text-center text-slate-400 italic font-semibold">No records match your exact query.</td></tr>`;
        } else {
            tbody.innerHTML = filteredGrades.map(g => {
                const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
                const cClass = gradeColorClass(pct || 0);
                return `
                <tr class="gb-row">
                    <td class="px-6 py-4 text-xs font-semibold text-slate-500">${g.date || '—'}</td>
                    <td class="px-6 py-4 font-bold text-slate-700">${g.studentName}</td>
                    <td class="px-6 py-4"><span class="text-xs font-black bg-indigo-50 text-indigo-600 border border-indigo-100 px-2.5 py-1 rounded-lg">${g.subject || '—'}</span></td>
                    <td class="px-6 py-4 font-bold text-slate-700 text-sm">${g.title || '—'}</td>
                    <td class="px-6 py-4"><span class="text-[10px] font-black uppercase tracking-wider bg-slate-100 text-slate-500 border border-slate-200 px-2 py-1 rounded-md">${g.type || '—'}</span></td>
                    <td class="px-6 py-4 text-center font-bold text-slate-600 text-sm">${g.score} / ${g.max || '?'}</td>
                    <td class="px-6 py-4 text-center"><span class="font-black text-sm ${cClass}">${pct !== null ? pct + '%' : '—'}</span></td>
                </tr>`;
            }).join('');
        }

        // Reveal the Results Area
        const area = document.getElementById('reportResultsArea');
        area.classList.remove('hidden');
        // Small timeout to allow display:block to apply before fading in
        setTimeout(() => { area.classList.remove('opacity-0'); }, 50);

    } catch (e) {
        console.error(e);
        alert("Error generating report.");
    }

    // Reset button
    btn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Report`;
    btn.disabled = false;
}

// ── 6. EXPORT / PRINT ───────────────────────────────────────────────────────
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
    downloadCSV(rows, `connectus_report_${safeName}.csv`);
};

window.printReport = function() {
    if (!currentQueryResults || currentQueryResults.length === 0) {
        alert("No data to print.");
        return;
    }
    
    const printDisclaimer = "<p style='font-size:10px;color:#64748b;margin-top:40px;text-align:center;border-top:1px solid #e2e8f0;padding-top:10px;font-style:italic;'>This document is automatically generated by ConnectUs Data Services.</p>";
    
    let html = `<html><head><title>Custom Report</title>
    <style>
        body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;padding:40px;color:#1e293b;line-height:1.5;font-size:13px;}
        .header{text-align:center;border-bottom:2px solid #cbd5e1;padding-bottom:20px;margin-bottom:30px;}
        .header h1{margin:0 0 5px 0;font-size:22px;color:#0f172a;text-transform:uppercase;letter-spacing:1px;}
        .header h2{margin:0;font-size:15px;color:#4f46e5;font-weight:bold;}
        .info-grid{background:#f8fafc;padding:15px;border-radius:6px;border:1px solid #e2e8f0;margin-bottom:30px;display:grid;grid-template-columns:1fr 1fr;gap:10px;}
        table{width:100%;border-collapse:collapse;margin-bottom:20px;}
        th,td{border:1px solid #e2e8f0;padding:8px 12px;text-align:left;}
        th{background:#f1f5f9;color:#475569;font-weight:bold;text-transform:uppercase;font-size:10px;letter-spacing:0.5px;}
        .tc{text-align:center;}
    </style></head><body>
    <div class="header">
        <h1>${session.teacherData.name} — ConnectUs</h1>
        <h2>Data Query: ${document.getElementById('reportOutputTitle').textContent}</h2>
    </div>
    <div class="info-grid">
        <div><strong>Period:</strong> ${currentQueryMeta.semName}</div>
        <div><strong>Scope:</strong> ${currentQueryMeta.scopeName}</div>
        <div><strong>Subject:</strong> ${currentQueryMeta.subName}</div>
        <div><strong>Grade Type:</strong> ${currentQueryMeta.typeName}</div>
    </div>
    <table>
        <thead>
            <tr>
                <th>Date</th>
                <th>Student</th>
                <th>Subject</th>
                <th>Assignment</th>
                <th>Type</th>
                <th class="tc">Score</th>
                <th class="tc">%</th>
            </tr>
        </thead>
        <tbody>`;
        
    currentQueryResults.forEach(g => {
        const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
        html += `
            <tr>
                <td>${g.date || '—'}</td>
                <td>${g.studentName}</td>
                <td>${g.subject}</td>
                <td>${g.title}</td>
                <td>${g.type}</td>
                <td class="tc">${g.score}/${g.max}</td>
                <td class="tc">${pct !== null ? pct + '%' : '—'}</td>
            </tr>`;
    });
    
    html += `</tbody></table>${printDisclaimer}</body></html>`;
    
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 500);
};

// Fire it up
init();
