import { db } from '../../assets/js/firebase-init.js';
import { collection, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { letterGrade, gradeColorClass } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('student', '../login.html');

// Inject layout
injectStudentLayout('reports', 'Official Reports', 'Download and print academic records');

// Update UI with session data
document.getElementById('displayStudentName').innerText = session.studentData.name || 'Student';
document.getElementById('studentAvatar').innerText = (session.studentData.name || 'S').charAt(0).toUpperCase();
document.getElementById('displayStudentClass').innerText = session.studentData.className ? `Class: ${session.studentData.className}` : 'Unassigned Class';

// Elements
const reportSemesterSelect = document.getElementById('reportSemesterSelect');
const generateReportCardBtn = document.getElementById('generateReportCardBtn');
const generateTranscriptBtn = document.getElementById('generateTranscriptBtn');

// State
let allSemesters = [];
let allGrades = [];
let schoolData = {};

// ── 2. INITIALIZE DATA ────────────────────────────────────────────────────
async function initializeReports() {
    try {
        // Fetch School Data (for print headers)
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolSnap.exists()) {
            schoolData = schoolSnap.data();
            document.getElementById('displaySchoolName').innerText = schoolData.schoolName;
        }

        // Fetch Semesters
        const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        allSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));

        // Populate Topbar Active Period Display
        const activeSemObj = allSemesters.find(s => s.id === schoolData.activeSemesterId);
        document.getElementById('activeSemesterDisplay').textContent = activeSemObj ? activeSemObj.name : 'Unknown';

        // Populate Dropdown
        reportSemesterSelect.innerHTML = allSemesters.map(s => 
            `<option value="${s.id}">${s.name}${s.id === schoolData.activeSemesterId ? ' (Current)' : ''}</option>`
        ).join('');
        
        if (schoolData.activeSemesterId) {
            reportSemesterSelect.value = schoolData.activeSemesterId;
        }

        // Fetch all grades for the student
        const gSnap = await getDocs(collection(db, 'schools', session.schoolId, 'students', session.studentId, 'grades'));
        allGrades = gSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Calculate High-Level Stats
        document.getElementById('totalAssignments').textContent = allGrades.length;
        
        if (allGrades.length > 0) {
            const totalAvg = allGrades.reduce((acc, g) => acc + (g.max ? (g.score / g.max) * 100 : 0), 0) / allGrades.length;
            const gpaEl = document.getElementById('cumulativeGpa');
            gpaEl.textContent = `${Math.round(totalAvg)}%`;
            // Add a little color depending on GPA
            if (totalAvg >= 90) gpaEl.classList.add('text-emerald-600');
            else if (totalAvg >= 80) gpaEl.classList.add('text-blue-600');
            else if (totalAvg >= 70) gpaEl.classList.add('text-teal-600');
            else if (totalAvg >= 65) gpaEl.classList.add('text-amber-600');
            else gpaEl.classList.add('text-red-600');
        } else {
            document.getElementById('cumulativeGpa').textContent = 'N/A';
        }

    } catch (e) {
        console.error("Error loading report data:", e);
        reportSemesterSelect.innerHTML = '<option value="">Error loading data</option>';
    }
}

// ── 3. PRINT GENERATOR LOGIC ──────────────────────────────────────────────
function generatePrintableDocument(isTranscript = false) {
    if (allGrades.length === 0) {
        alert("No academic records found to generate a report.");
        return;
    }

    const targetSemesterId = reportSemesterSelect.value;
    const targetSemesterName = reportSemesterSelect.options[reportSemesterSelect.selectedIndex]?.text || 'Unknown Period';

    // Group grades by Semester -> Subject
    const bySem = {};
    allGrades.forEach(g => {
        const semId = g.semesterId || 'Unknown';
        // If it's not a full transcript, filter out grades that don't match the selected semester
        if (!isTranscript && semId !== targetSemesterId) return;

        const semName = allSemesters.find(s => s.id === semId)?.name || 'Unknown Period';
        const sub = g.subject || 'Uncategorized';
        
        if (!bySem[semName]) bySem[semName] = {};
        if (!bySem[semName][sub]) bySem[semName][sub] = [];
        bySem[semName][sub].push(g);
    });

    const docTitle = isTranscript ? "OFFICIAL ACADEMIC TRANSCRIPT" : `STUDENT REPORT CARD`;
    const docSubtitle = isTranscript ? "Complete Academic History" : targetSemesterName.replace(' (Current)', '');

    let html = `<html><head><title>${docTitle} - ${session.studentData.name}</title>
    <style>
        body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; color: #1e293b; line-height: 1.5; }
        .header { text-align: center; border-bottom: 2px solid #cbd5e1; padding-bottom: 20px; margin-bottom: 30px; }
        .header h1 { margin: 0 0 5px 0; font-size: 24px; color: #0f172a; text-transform: uppercase; letter-spacing: 1px; }
        .header h2 { margin: 0; font-size: 16px; color: #64748b; font-weight: normal; letter-spacing: 2px; }
        .header h3 { margin: 5px 0 0 0; font-size: 14px; color: #4f46e5; }
        .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 40px; background: #f8fafc; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0; }
        .info-item label { display: block; font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: bold; letter-spacing: 1px; }
        .info-item span { font-size: 14px; font-weight: bold; color: #0f172a; }
        .sem-block { margin-bottom: 40px; page-break-inside: avoid; }
        .sem-title { font-size: 16px; font-weight: bold; background: #312e81; color: white; padding: 8px 15px; margin: 0 0 15px 0; border-radius: 4px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 13px; }
        th, td { border: 1px solid #e2e8f0; padding: 10px 15px; text-align: left; }
        th { background: #f1f5f9; color: #475569; font-weight: bold; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
        .text-center { text-align: center; }
        .text-right { text-align: right; }
        .avg-row { background: #f8fafc; font-weight: bold; }
        .footer { margin-top: 50px; text-align: center; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 15px; }
    </style></head><body>

    <div class="header">
        <h1>${schoolData.schoolName || 'ConnectUs School'}</h1>
        <h2>${docTitle}</h2>
        <h3>${docSubtitle}</h3>
    </div>

    <div class="info-grid">
        <div class="info-item"><label>Student Name</label><span>${session.studentData.name || 'Unknown'}</span></div>
        <div class="info-item"><label>Student ID / PIN</label><span>${session.studentData.pin || 'N/A'}</span></div>
        <div class="info-item"><label>Class</label><span>${session.studentData.className || 'Unassigned'}</span></div>
        <div class="info-item"><label>Date Generated</label><span>${new Date().toLocaleDateString()}</span></div>
    </div>`;

    if (Object.keys(bySem).length === 0) {
        html += `<p style="text-align:center; color:#64748b; font-style:italic; padding: 40px;">No academic grades recorded for the selected criteria.</p>`;
    } else {
        for (let semName in bySem) {
            html += `<div class="sem-block"><h3 class="sem-title">${semName}</h3><table>
                <thead><tr><th>Subject</th><th class="text-center">Assignments</th><th class="text-center">Average (%)</th><th class="text-center">Letter Grade</th></tr></thead><tbody>`;
            
            let semTotalPct = 0; let semSubjCount = 0;
            
            // Sort subjects alphabetically
            const subjects = Object.keys(bySem[semName]).sort();
            
            for (let sub of subjects) {
                const sGrades = bySem[semName][sub];
                const avg = Math.round(sGrades.reduce((acc, g) => acc + (g.max ? (g.score / g.max) * 100 : 0), 0) / sGrades.length);
                semTotalPct += avg; semSubjCount++;
                html += `<tr><td>${sub}</td><td class="text-center">${sGrades.length}</td><td class="text-center">${avg}%</td><td class="text-center">${letterGrade(avg)}</td></tr>`;
            }
            const semAvg = Math.round(semTotalPct / semSubjCount);
            html += `<tr class="avg-row"><td colspan="2" class="text-right">PERIOD AVERAGE:</td><td class="text-center">${semAvg}%</td><td class="text-center">${letterGrade(semAvg)}</td></tr>`;
            html += `</tbody></table></div>`;
        }
    }

    html += `<div class="footer">Document generated securely via ConnectUs Family Portal.<br>For an officially sealed copy, please contact the administration office.</div></body></html>`;
    
    const w = window.open('', '_blank'); 
    w.document.write(html); 
    w.document.close();
    setTimeout(() => w.print(), 500);
}

// ── 4. EVENT LISTENERS ────────────────────────────────────────────────────
generateReportCardBtn.addEventListener('click', () => generatePrintableDocument(false));
generateTranscriptBtn.addEventListener('click', () => generatePrintableDocument(true));

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initializeReports);
