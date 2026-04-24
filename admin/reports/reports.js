import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { letterGrade, gradeColorClass } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');

// Inject layout
injectAdminLayout('reports', 'Executive Reports', 'High-level analytics and performance tracking', false, false);

// Elements
const reportPeriod = document.getElementById('reportPeriod');
const reportScope = document.getElementById('reportScope');
const targetContainer = document.getElementById('targetContainer');
const targetLabel = document.getElementById('targetLabel');
const reportTarget = document.getElementById('reportTarget');
const generateBtn = document.getElementById('generateBtn');
const reportLoader = document.getElementById('reportLoader');
const reportResults = document.getElementById('reportResults');
const reportTableHead = document.getElementById('reportTableHead');
const reportTableBody = document.getElementById('reportTableBody');

// Cached Data
let allSemesters = [];
let allTeachers = [];
let allStudents = [];
let CLASSES = [];

// ── 2. PRE-LOAD SYSTEM DATA ───────────────────────────────────────────────
async function initializeBuilder() {
    try {
        // Fetch baseline data for dropdowns
        // CHANGED: teachers and students from global collections
        const [semSnap, tSnap, sSnap] = await Promise.all([
            getDocs(collection(db, 'schools', session.schoolId, 'semesters')),
            getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId))),
            getDocs(query(collection(db, 'students'),
                where('currentSchoolId', '==', session.schoolId),
                where('enrollmentStatus', '==', 'Active')))
        ]);

        allSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => !s.archived).sort((a,b) => a.order - b.order);
        allTeachers  = tSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        allStudents  = sSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Populate Periods
        allSemesters.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.name;
            if (s.id === session.activeSemesterId) opt.selected = true;
            reportPeriod.appendChild(opt);
        });

        // Determine Classes based on school type
        const schoolType = session.schoolType || 'Primary';
        CLASSES = schoolType === 'Primary' ? ['Infant 1', 'Infant 2', 'Standard 1', 'Standard 2', 'Standard 3', 'Standard 4', 'Standard 5', 'Standard 6'] :
                  schoolType === 'High School' ? ['First Form', 'Second Form', 'Third Form', 'Fourth Form'] : ['Year 1', 'Year 2'];

    } catch (e) {
        console.error("Error initializing report builder:", e);
    }
}

// ── 3. DYNAMIC DROPDOWNS LOGIC ────────────────────────────────────────────
reportScope.addEventListener('change', (e) => {
    const scope = e.target.value;
    reportTarget.innerHTML = '<option value="">Select Target...</option>';

    if (scope === 'school') {
        targetContainer.classList.add('opacity-50', 'pointer-events-none');
        setTimeout(() => targetContainer.classList.add('hidden'), 300);
        return;
    }

    targetContainer.classList.remove('hidden');
    // small delay for transition
    setTimeout(() => targetContainer.classList.remove('opacity-50', 'pointer-events-none'), 10);

    if (scope === 'teacher') {
        targetLabel.textContent = 'Select Teacher';
        allTeachers.forEach(t => reportTarget.innerHTML += `<option value="${t.id}">${t.name}</option>`);
    } else if (scope === 'class') {
        targetLabel.textContent = 'Select Class';
        CLASSES.forEach(c => reportTarget.innerHTML += `<option value="${c}">${c}</option>`);
    } else if (scope === 'student') {
        targetLabel.textContent = 'Select Student';
        allStudents.forEach(s => reportTarget.innerHTML += `<option value="${s.id}">${s.name} (${s.className || 'Unassigned'})</option>`);
    }
});

// ── 4. AGGREGATE & GENERATE LOGIC ─────────────────────────────────────────
generateBtn.addEventListener('click', async () => {
    const period = reportPeriod.value;
    const scope = reportScope.value;
    const target = reportTarget.value;
    const subject = document.getElementById('reportSubject').value;

    if (scope !== 'school' && !target) {
        alert('Please select a target for the report.');
        return;
    }

    // UI State
    reportResults.classList.add('hidden', 'opacity-0');
    reportLoader.classList.remove('hidden');
    reportLoader.classList.add('flex');

    try {
        // Step 1: Filter which students we care about based on scope
        let targetStudents = [];
        if (scope === 'school') {
            targetStudents = allStudents;
            document.getElementById('reportTitle').textContent = "School-Wide Performance";
            document.getElementById('tableTitle').textContent = "Ranked By Class";
        } else if (scope === 'teacher') {
            targetStudents = allStudents.filter(s => s.teacherId === target);
            const tName = allTeachers.find(t => t.id === target)?.name;
            document.getElementById('reportTitle').textContent = `Teacher Report: ${tName}`;
            document.getElementById('tableTitle').textContent = "Ranked By Student";
        } else if (scope === 'class') {
            targetStudents = allStudents.filter(s => s.className === target);
            document.getElementById('reportTitle').textContent = `Class Report: ${target}`;
            document.getElementById('tableTitle').textContent = "Ranked By Student";
        } else if (scope === 'student') {
            targetStudents = allStudents.filter(s => s.id === target);
            document.getElementById('reportTitle').textContent = `Student Report: ${targetStudents[0]?.name}`;
            document.getElementById('tableTitle').textContent = "Breakdown By Subject";
        }

        // Step 2: Fetch all grades for these students (The heavy lift)
        const allGrades = [];
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        let recentGradesCount = 0;

        await Promise.all(targetStudents.map(async (s) => {
            const snap = await getDocs(collection(db, 'schools', session.schoolId, 'students', s.id, 'grades'));
            snap.forEach(doc => {
                const g = doc.data();
                // Apply Period Filter
                if (period !== 'all' && g.semesterId !== period) return;
                // Apply Subject Filter
                if (subject !== 'all' && g.subject !== subject) return;
                
                g.studentId = s.id;
                g.studentName = s.name;
                g.className = s.className;
                
                // Check engagement (created or edited in last 7 days)
                const logDate = g.historyLogs && g.historyLogs.length ? new Date(g.historyLogs[g.historyLogs.length-1].changedAt) : (g.date ? new Date(g.date) : null);
                if (logDate && logDate >= sevenDaysAgo) recentGradesCount++;

                allGrades.push(g);
            });
        }));

        // Step 3: Calculate The "Pulse"
        const studentAverages = []; // Array of { id, avg }
        targetStudents.forEach(s => {
            const sGrades = allGrades.filter(g => g.studentId === s.id);
            if (sGrades.length) {
                const avg = sGrades.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / sGrades.length;
                studentAverages.push({ id: s.id, avg: Math.round(avg), className: s.className });
            }
        });

        const totalGpa = studentAverages.length ? Math.round(studentAverages.reduce((a, s) => a + s.avg, 0) / studentAverages.length) : null;
        const atRiskCount = studentAverages.filter(s => s.avg < 65).length;
        
        // Mock engagement: If recent grades > targetStudents / 2, we call it High. (Just a conceptual metric)
        const engagementLevel = recentGradesCount > targetStudents.length ? 'High <i class="fa-solid fa-fire text-orange-500 ml-1"></i>' : (recentGradesCount > 0 ? 'Moderate' : 'Low');

        document.getElementById('pulseGpa').innerHTML = totalGpa !== null ? `${totalGpa}%` : 'N/A';
        document.getElementById('pulseGpa').className = `text-4xl font-black ${totalGpa !== null ? gradeColorClass(totalGpa) : 'text-slate-400'}`;
        document.getElementById('pulseEngagement').innerHTML = engagementLevel;
        document.getElementById('pulseAtRisk').textContent = atRiskCount;
        document.getElementById('pulseVolume').textContent = allGrades.length.toLocaleString();

        // Step 4: Distribution Bar
        const dist = { a: 0, b: 0, c: 0, d: 0, f: 0 };
        studentAverages.forEach(s => {
            if (s.avg >= 90) dist.a++;
            else if (s.avg >= 80) dist.b++;
            else if (s.avg >= 70) dist.c++;
            else if (s.avg >= 65) dist.d++;
            else dist.f++;
        });
        
        const totalAvgs = studentAverages.length || 1;
        const distHTML = `
            ${dist.a ? `<div class="dist-seg bg-emerald-500" style="width:${dist.a / totalAvgs * 100}%">A:${dist.a}</div>` : ''}
            ${dist.b ? `<div class="dist-seg bg-blue-500" style="width:${dist.b / totalAvgs * 100}%">B:${dist.b}</div>` : ''}
            ${dist.c ? `<div class="dist-seg bg-teal-500" style="width:${dist.c / totalAvgs * 100}%">C:${dist.c}</div>` : ''}
            ${dist.d ? `<div class="dist-seg bg-amber-500" style="width:${dist.d / totalAvgs * 100}%">D:${dist.d}</div>` : ''}
            ${dist.f ? `<div class="dist-seg bg-red-500" style="width:${dist.f / totalAvgs * 100}%">F:${dist.f}</div>` : ''}
            ${studentAverages.length === 0 ? `<div class="dist-seg bg-slate-300" style="width:100%">No Data</div>` : ''}
        `;
        document.getElementById('distBar').innerHTML = distHTML;
        document.getElementById('distLabels').innerHTML = [['A', dist.a, 'bg-emerald-500'], ['B', dist.b, 'bg-blue-500'], ['C', dist.c, 'bg-teal-500'], ['D', dist.d, 'bg-amber-500'], ['F', dist.f, 'bg-red-500']].map(([l, n, c]) => `<div class="flex items-center gap-1.5"><div class="w-3 h-3 rounded-sm ${c}"></div><span class="text-xs font-black text-slate-600">${l}: ${n}</span></div>`).join('');

        // Step 5: Render Comparison Table
        renderTable(scope, studentAverages, allGrades, targetStudents);

        // Hide Loader, Show Results
        reportLoader.classList.remove('flex');
        reportLoader.classList.add('hidden');
        reportResults.classList.remove('hidden');
        setTimeout(() => reportResults.classList.remove('opacity-0'), 50);

    } catch (e) {
        console.error("Error generating report:", e);
        alert("An error occurred while building the report. Please try again.");
        reportLoader.classList.remove('flex');
        reportLoader.classList.add('hidden');
    }
});

function renderTable(scope, studentAverages, allGrades, targetStudents) {
    if (scope === 'school') {
        // Group by Class
        reportTableHead.innerHTML = `<tr><th class="px-6 py-4 font-black">Class Name</th><th class="px-6 py-4 font-black text-center">Students</th><th class="px-6 py-4 font-black text-center">Class GPA</th><th class="px-6 py-4 font-black text-center">At Risk</th></tr>`;
        
        const byClass = {};
        CLASSES.forEach(c => byClass[c] = { count: 0, sum: 0, atRisk: 0, avgs: 0 });
        
        studentAverages.forEach(s => {
            const cName = s.className || 'Unassigned';
            if (!byClass[cName]) byClass[cName] = { count: 0, sum: 0, atRisk: 0, avgs: 0 };
            byClass[cName].count++;
            byClass[cName].sum += s.avg;
            byClass[cName].avgs++;
            if (s.avg < 65) byClass[cName].atRisk++;
        });

        reportTableBody.innerHTML = Object.entries(byClass)
            .filter(([_, data]) => data.count > 0)
            .sort((a, b) => (b[1].sum / b[1].avgs) - (a[1].sum / a[1].avgs)) // Sort by GPA desc
            .map(([cName, data]) => {
                const classAvg = Math.round(data.sum / data.avgs);
                return `<tr class="gb-row">
                    <td class="px-6 py-4 font-black text-slate-700">${cName}</td>
                    <td class="px-6 py-4 text-center font-semibold text-slate-600">${data.count}</td>
                    <td class="px-6 py-4 text-center"><span class="${gradeColorClass(classAvg)} font-black">${classAvg}%</span></td>
                    <td class="px-6 py-4 text-center"><span class="font-black ${data.atRisk > 0 ? 'text-red-500' : 'text-slate-400'}">${data.atRisk}</span></td>
                </tr>`;
            }).join('');
            
    } else if (scope === 'teacher' || scope === 'class') {
        // Rank Students
        reportTableHead.innerHTML = `<tr><th class="px-6 py-4 font-black">Student Name</th><th class="px-6 py-4 font-black text-center">GPA</th><th class="px-6 py-4 font-black text-center">Letter Grade</th><th class="px-6 py-4 font-black text-center">Grades Logged</th></tr>`;
        
        reportTableBody.innerHTML = studentAverages.sort((a, b) => b.avg - a.avg).map(s => {
            const student = targetStudents.find(ts => ts.id === s.id);
            const count = allGrades.filter(g => g.studentId === s.id).length;
            return `<tr class="gb-row">
                <td class="px-6 py-4 font-black text-slate-700">${student.name}</td>
                <td class="px-6 py-4 text-center"><span class="${gradeColorClass(s.avg)} font-black">${s.avg}%</span></td>
                <td class="px-6 py-4 text-center font-bold text-slate-500">${letterGrade(s.avg)}</td>
                <td class="px-6 py-4 text-center font-semibold text-slate-400">${count}</td>
            </tr>`;
        }).join('');

    } else if (scope === 'student') {
        // Breakdown by Subject
        reportTableHead.innerHTML = `<tr><th class="px-6 py-4 font-black">Subject</th><th class="px-6 py-4 font-black text-center">Average</th><th class="px-6 py-4 font-black text-center">Assignments</th></tr>`;
        
        const bySubj = {};
        allGrades.forEach(g => {
            const sub = g.subject || 'Uncategorized';
            if (!bySubj[sub]) bySubj[sub] = [];
            bySubj[sub].push(g);
        });

        reportTableBody.innerHTML = Object.entries(bySubj).map(([sub, grades]) => {
            const avg = Math.round(grades.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / grades.length);
            return `<tr class="gb-row">
                <td class="px-6 py-4 font-black text-slate-700">${sub}</td>
                <td class="px-6 py-4 text-center"><span class="${gradeColorClass(avg)} font-black">${avg}%</span></td>
                <td class="px-6 py-4 text-center font-semibold text-slate-400">${grades.length}</td>
            </tr>`;
        }).join('');
    }
}

// ── 5. EXPORT LOGIC ───────────────────────────────────────────────────────
document.getElementById('printReportBtn').addEventListener('click', () => {
    window.print();
});

// CSV Export (Simplified dump of the table)
document.getElementById('exportCsvBtn').addEventListener('click', () => {
    const rows = [];
    // Grab headers
    const headers = [];
    document.querySelectorAll('#reportTableHead th').forEach(th => headers.push(th.innerText));
    rows.push(headers);
    
    // Grab rows
    document.querySelectorAll('#reportTableBody tr').forEach(tr => {
        const rowData = [];
        tr.querySelectorAll('td').forEach(td => rowData.push(td.innerText));
        rows.push(rowData);
    });
    
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `ConnectUs_Report.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
});

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initializeBuilder);
