import { db } from '../../assets/js/firebase-init.js';
import { collection, query, getDocs, getDoc, doc, updateDoc, deleteDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { openOverlay, closeOverlay, letterGrade } from '../../assets/js/utils.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('archives', 'Archives', 'Archived students and subjects', false);
}

// ── 2. STATE VARIABLES ──────────────────────────────────────────────────────
let currentStudentId = null;
let rawSemesters = [];

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    // Attach Search Listener
    document.getElementById('archiveStudentSearch').addEventListener('input', filterArchivedStudents);
    
    // Attach Print Modal Listeners
    document.getElementById('closePrintBtn').addEventListener('click', () => {
        closeOverlay('printStudentModal', 'printStudentModalInner');
    });
    document.getElementById('executePrintBtn').addEventListener('click', executeStudentPrint);

    await loadSemesters(); // Needed for printing records
    await loadArchivesTab();
}

async function loadSemesters() {
    try {
        const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        rawSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
    } catch (e) {
        console.error("Error loading semesters:", e);
    }
}

function getArchivedSubjects() {
    return (session.teacherData.subjects || []).filter(s => s.archived);
}

// ── 4. LOAD DATA ────────────────────────────────────────────────────────────
async function loadArchivesTab() {
    const studentListEl = document.getElementById('archivesStudentList');
    const subjectListEl = document.getElementById('archivesSubjectList');

    studentListEl.innerHTML = '<div class="text-center py-6 text-slate-400 italic text-sm"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading...</div>';
    subjectListEl.innerHTML = '<div class="text-center py-6 text-slate-400 italic text-sm"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading...</div>';

    // Load Archived Students
    try {
        const snap = await getDocs(collection(db, 'schools', session.schoolId, 'students'));
        
        // Filter: Must be archived AND belong to this teacher (or have no teacher assigned after archiving)
        const archivedStudents = snap.docs.filter(d => {
            const data = d.data();
            return data.archived && (data.teacherId === session.teacherId || !data.teacherId || data.teacherId === '');
        });
        
        document.getElementById('archivesStudentCount').textContent = archivedStudents.length;

        if (archivedStudents.length) {
            studentListEl.innerHTML = archivedStudents.sort((a, b) => ((b.data().archivedAt || '').localeCompare(a.data().archivedAt || ''))).map(d => {
                const s = d.data();
                return `
                <div class="archive-student-row flex flex-wrap items-center justify-between bg-slate-50 border border-slate-200 rounded-xl p-4 mb-3 gap-3">
                    <div class="flex-1 min-w-0">
                        <p class="font-black text-slate-800">${s.name || 'Unnamed'}</p>
                        <p class="text-xs text-slate-500 font-semibold mt-0.5">
                            ${s.className ? `Class: ${s.className} · ` : ''}Archived ${s.archivedAt ? new Date(s.archivedAt).toLocaleDateString() : '—'}
                            ${s.archiveReason ? `<br><span class="text-amber-700 font-bold">Reason: ${s.archiveReason}</span>` : ''}
                        </p>
                    </div>
                    <div class="flex gap-2 flex-shrink-0">
                        <button onclick="printStudentRecord('${d.id}')" class="text-xs font-black text-slate-600 hover:bg-slate-200 border border-slate-300 bg-white px-3 py-1.5 rounded-lg transition flex items-center gap-1.5"><i class="fa-solid fa-print text-[10px]"></i> Print</button>
                        <button onclick="restoreStudent('${d.id}')" class="text-xs font-black text-emerald-700 hover:bg-emerald-600 hover:text-white border border-emerald-300 bg-white px-3 py-1.5 rounded-lg transition">Restore</button>
                        <button onclick="permanentDeleteStudent('${d.id}')" class="text-xs font-black text-red-600 hover:bg-red-600 hover:text-white border border-red-300 bg-white px-3 py-1.5 rounded-lg transition">Delete</button>
                    </div>
                </div>`;
            }).join('');
        } else {
            studentListEl.innerHTML = '<p class="text-sm text-slate-400 italic text-center py-6 bg-slate-50 rounded-xl">No archived students.</p>';
        }
    } catch (e) {
        console.error(e);
        studentListEl.innerHTML = '<p class="text-sm text-red-400 italic text-center py-4">Error loading archived students.</p>';
    }

    // Load Archived Subjects
    const archivedSubjects = getArchivedSubjects();
    document.getElementById('archivesSubjCount').textContent = archivedSubjects.length;

    if (archivedSubjects.length) {
        subjectListEl.innerHTML = archivedSubjects.sort((a, b) => ((b.archivedAt || '').localeCompare(a.archivedAt || ''))).map(s => `
        <div class="archive-subj-row flex flex-wrap items-center justify-between bg-slate-50 border border-slate-200 rounded-xl p-4 mb-3 gap-3">
            <div class="flex-1 min-w-0">
                <p class="font-black text-slate-500 line-through">${s.name}</p>
                <p class="text-xs text-slate-400 font-semibold mt-0.5">Archived ${s.archivedAt ? new Date(s.archivedAt).toLocaleDateString() : '—'} · All existing grades preserved</p>
            </div>
            <div class="flex gap-2 flex-shrink-0">
                <button onclick="restoreSubject('${s.id}')" class="text-xs font-black text-emerald-700 hover:bg-emerald-600 hover:text-white border border-emerald-300 bg-white px-3 py-1.5 rounded-lg transition">Restore</button>
                <button onclick="permanentDeleteSubject('${s.id}')" class="text-xs font-black text-red-600 hover:bg-red-600 hover:text-white border border-red-300 bg-white px-3 py-1.5 rounded-lg transition">Delete</button>
            </div>
        </div>`).join('');
    } else {
        subjectListEl.innerHTML = '<p class="text-sm text-slate-400 italic text-center py-6 bg-slate-50 rounded-xl">No archived subjects.</p>';
    }
}

// Search Filter for Students
function filterArchivedStudents() {
    const term = document.getElementById('archiveStudentSearch').value.toLowerCase();
    document.querySelectorAll('.archive-student-row').forEach(row => {
        row.style.display = row.textContent.toLowerCase().includes(term) ? '' : 'none';
    });
}

// ── 5. STUDENT ACTIONS ──────────────────────────────────────────────────────
window.restoreStudent = async function(id) {
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'students', id), {
            archived: false,
            archivedAt: null,
            teacherId: session.teacherId // Re-claim the student automatically
        });
        loadArchivesTab(); // Refresh the list
    } catch (e) {
        console.error(e);
        alert("Error restoring student.");
    }
};

window.permanentDeleteStudent = async function(id) {
    if (!confirm('Permanently delete this student and ALL their grades? This action CANNOT be undone.')) return;
    
    try {
        // 1. Delete all grade subcollection documents first
        const gradesSnap = await getDocs(collection(db, 'schools', session.schoolId, 'students', id, 'grades'));
        const batch = writeBatch(db);
        
        gradesSnap.forEach(d => batch.delete(d.ref));
        if (!gradesSnap.empty) {
            await batch.commit();
        }
        
        // 2. Delete the student document
        await deleteDoc(doc(db, 'schools', session.schoolId, 'students', id));
        loadArchivesTab(); // Refresh the list
    } catch (e) {
        console.error('Deletion error:', e);
        alert("Failed to permanently delete student data.");
    }
};

// ── 6. SUBJECT ACTIONS ──────────────────────────────────────────────────────
window.restoreSubject = async function(subjectId) {
    const newSubs = session.teacherData.subjects.map(s => 
        s.id === subjectId ? { ...s, archived: false, archivedAt: null } : s
    );
    
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { subjects: newSubs });
        session.teacherData.subjects = newSubs;
        sessionStorage.setItem('connectus_teacher_session', JSON.stringify(session));
        loadArchivesTab();
    } catch (e) {
        console.error(e);
    }
};

window.permanentDeleteSubject = async function(subjectId) {
    const sub = (session.teacherData.subjects || []).find(s => s.id === subjectId);
    if (!sub) return;
    
    if (!confirm(`Permanently delete "${sub.name}"? Existing student grades will still reference this subject name text, but the subject will be removed from your lists entirely.`)) return;
    
    const newSubs = session.teacherData.subjects.filter(s => s.id !== subjectId);
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { subjects: newSubs });
        session.teacherData.subjects = newSubs;
        sessionStorage.setItem('connectus_teacher_session', JSON.stringify(session));
        loadArchivesTab();
    } catch (e) {
        console.error(e);
    }
};

// ── 7. PRINT RECORD LOGIC ───────────────────────────────────────────────────
window.printStudentRecord = function(studentId) {
    currentStudentId = studentId;
    
    // Populate the subjects drop down in the modal with all subjects (active & archived)
    const psSubj = document.getElementById('psSubject');
    const allSubjects = session.teacherData.subjects || [];
    psSubj.innerHTML = '<option value="all">All Subjects</option>' + allSubjects.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
    
    openOverlay('printStudentModal', 'printStudentModalInner');
};

async function executeStudentPrint() {
    const mode = document.getElementById('psMode').value;
    const subjFilter = document.getElementById('psSubject').value;
    const studentId = currentStudentId;
    
    try {
        const sDoc = await getDoc(doc(db, 'schools', session.schoolId, 'students', studentId));
        if (!sDoc.exists()) {
            alert('Student not found.');
            return;
        }
        
        const s = sDoc.data();
        const gradesSnap = await getDocs(collection(db, 'schools', session.schoolId, 'students', studentId, 'grades'));
        
        let grades = [];
        gradesSnap.forEach(d => grades.push(d.data()));
        
        // Group by Semester -> Subject
        const bySem = {};
        grades.forEach(g => {
            if (subjFilter !== 'all' && g.subject !== subjFilter) return;
            const sem = rawSemesters.find(sm => sm.id === g.semesterId)?.name || 'Unknown Period';
            const sub = g.subject || 'Uncategorized';
            
            if (!bySem[sem]) bySem[sem] = {};
            if (!bySem[sem][sub]) bySem[sem][sub] = [];
            bySem[sem][sub].push(g);
        });
        
        let html = `<html><head><title>Student Record - ${s.name}</title>
        <style>
            body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;padding:40px;color:#1e293b;line-height:1.5;}
            .header{text-align:center;border-bottom:2px solid #cbd5e1;padding-bottom:20px;margin-bottom:30px;}
            .header h1{margin:0 0 5px 0;font-size:22px;color:#0f172a;text-transform:uppercase;letter-spacing:1px;}
            .header h2{margin:0;font-size:14px;color:#059669;font-weight:bold;letter-spacing:2px;}
            .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-bottom:40px;background:#f8fafc;padding:20px;border-radius:8px;border:1px solid #e2e8f0;}
            .info-item label{display:block;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:bold;letter-spacing:1px;}
            .info-item span{font-size:14px;font-weight:bold;color:#0f172a;}
            .sem-block{margin-bottom:40px;page-break-inside:avoid;}
            .sem-title{font-size:14px;font-weight:bold;background:#064e3b;color:white;padding:8px 15px;margin:0 0 15px 0;border-radius:4px;}
            table{width:100%;border-collapse:collapse;margin-bottom:10px;font-size:13px;}
            th,td{border:1px solid #e2e8f0;padding:8px 12px;text-align:left;}
            th{background:#f1f5f9;color:#475569;font-weight:bold;text-transform:uppercase;font-size:10px;letter-spacing:0.5px;}
            .tc{text-align:center;}.tr{text-align:right;}
            .avg-row{background:#f8fafc;font-weight:bold;}
        </style></head><body>
        <div class="header"><h1>ConnectUs — Official Record</h1><h2>STUDENT ${mode === 'summary' ? 'REPORT CARD' : 'DETAILED TRANSCRIPT'}</h2></div>
        <div class="info-grid">
            <div class="info-item"><label>Student Name</label><span>${s.name}</span></div>
            <div class="info-item"><label>Status</label><span>${s.archived ? 'Archived / Transferred' : 'Active'}</span></div>
            <div class="info-item"><label>Last Known Class</label><span>${s.className || 'Unassigned'}</span></div>
            <div class="info-item"><label>Teacher</label><span>${session.teacherData.name}</span></div>
        </div>`;
        
        if (!Object.keys(bySem).length) {
            html += `<p style="text-align:center;color:#64748b;font-style:italic;padding:40px;">No grades recorded matching filters.</p>`;
        } else {
            for (let sem in bySem) {
                html += `<div class="sem-block"><h3 class="sem-title">${sem}</h3><table>`;
                if (mode === 'summary') {
                    html += `<thead><tr><th>Subject</th><th class="tc">Assignments</th><th class="tc">Average (%)</th><th class="tc">Letter Grade</th></tr></thead><tbody>`;
                    let semTotalPct = 0; let semSubjCount = 0;
                    for (let sub in bySem[sem]) {
                        const sGrades = bySem[sem][sub];
                        const avg = Math.round(sGrades.reduce((acc, g) => acc + (g.max ? (g.score / g.max) * 100 : 0), 0) / sGrades.length);
                        semTotalPct += avg; semSubjCount++;
                        html += `<tr><td>${sub}</td><td class="tc">${sGrades.length}</td><td class="tc">${avg}%</td><td class="tc">${letterGrade(avg)}</td></tr>`;
                    }
                    const semAvg = Math.round(semTotalPct / semSubjCount);
                    html += `<tr class="avg-row"><td colspan="2" class="tr">PERIOD AVERAGE:</td><td class="tc">${semAvg}%</td><td class="tc">${letterGrade(semAvg)}</td></tr></tbody></table></div>`;
                } else {
                    html += `<thead><tr><th>Subject</th><th>Assignment</th><th>Type</th><th class="tc">Score</th><th class="tc">%</th></tr></thead><tbody>`;
                    for (let sub in bySem[sem]) {
                        const sGrades = bySem[sem][sub].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
                        sGrades.forEach(g => {
                            const pct = g.max ? Math.round(g.score / g.max * 100) : null;
                            html += `<tr><td>${sub}</td><td>${g.title}<br><span style="font-size:10px;color:#94a3b8">${g.date || ''}</span></td><td>${g.type}</td><td class="tc">${g.score}/${g.max}</td><td class="tc">${pct !== null ? pct + '%' : '—'}</td></tr>`;
                        });
                    }
                    html += `</tbody></table></div>`;
                }
            }
        }
        
        const printDisclaimer = "<p style='font-size:10px;color:#64748b;margin-top:40px;text-align:center;border-top:1px solid #e2e8f0;padding-top:10px;font-style:italic;'>This document does not constitute an official report card.</p>";
        html += printDisclaimer + `</body></html>`;
        
        const w = window.open('', '_blank');
        w.document.write(html);
        w.document.close();
        
        closeOverlay('printStudentModal', 'printStudentModalInner');
        setTimeout(() => w.print(), 500);
        
    } catch (e) {
        console.error(e);
        alert('Error generating print.');
    }
}

// Fire it up
init();
