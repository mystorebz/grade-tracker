import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, updateDoc, deleteDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { openOverlay, closeOverlay, letterGrade, calculateWeightedAverage } from '../../assets/js/utils.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('archives', 'Archives', 'Archived students and subjects', false);
}

// ── 2. STATE VARIABLES ──────────────────────────────────────────────────────
let currentStudentId = null;
let rawSemesters = [];

// UPDATED: Added helper to fetch the teacher's custom grade types
const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
function getGradeTypes() { return session.teacherData.gradeTypes || session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES; }

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

// ── HELPER: resolve correct teacher document path (global vs legacy) ──────────
function getTeacherRef() {
    return /^T\d{2}-[A-Z0-9]{5}$/i.test(session.teacherId)
        ? doc(db, 'teachers', session.teacherId)
        : doc(db, 'schools', session.schoolId, 'teachers', session.teacherId);
}

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    const searchInput = document.getElementById('archiveStudentSearch');
    if (searchInput) searchInput.addEventListener('input', filterArchivedStudents);
    
    document.getElementById('closePrintBtn').addEventListener('click', () => {
        closeOverlay('printStudentModal', 'printStudentModalInner');
    });
    document.getElementById('executePrintBtn').addEventListener('click', executeStudentPrint);

    await loadSemesters(); 
    await loadArchivesTab();
}

// ── THE FIX: POPULATING TOPBAR & SIDEBAR ──
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

        // Bind directly to the topbar dropdown injected by layout-teachers.js
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
            
            // Sync sidebar text
            if (sbPeriod) sbPeriod.textContent = topSemSel.options[topSemSel.selectedIndex]?.text || '—';
            
            topSemSel.addEventListener('change', () => {
                if (sbPeriod) sbPeriod.textContent = topSemSel.options[topSemSel.selectedIndex]?.text || '—';
            });
        }
    } catch (e) {
        console.error("[Archives] Error loading semesters:", e);
    }
}

function getArchivedSubjects() {
    return (session.teacherData.subjects || []).filter(s => s.archived);
}

// ── 4. LOAD DATA ────────────────────────────────────────────────────────────
async function loadArchivesTab() {
    const studentListEl = document.getElementById('archivesStudentList');
    const subjectListEl = document.getElementById('archivesSubjectList');

    studentListEl.innerHTML = '<div class="text-center py-10 text-[#9ab0c6] text-[13px] font-bold"><i class="fa-solid fa-spinner fa-spin text-[#2563eb] text-2xl mb-3 block"></i>Loading archived records...</div>';
    subjectListEl.innerHTML = '<div class="text-center py-10 text-[#9ab0c6] text-[13px] font-bold"><i class="fa-solid fa-spinner fa-spin text-[#2563eb] text-2xl mb-3 block"></i>Loading archived subjects...</div>';

    try {
        // CHANGED: query global /students for non-active students at this school
        const q = query(
            collection(db, 'students'),
            where('currentSchoolId', '==', session.schoolId),
            where('enrollmentStatus', 'in', ['Archived', 'Graduated', 'Expelled', 'Dropped Out'])
        );
        const snap = await getDocs(q);
        
        const archivedStudents = snap.docs.filter(d => {
            const data = d.data();
            return data.teacherId === session.teacherId || !data.teacherId || data.teacherId === '';
        });
        
        const countEl = document.getElementById('archivesStudentCount');
        if (countEl) countEl.textContent = archivedStudents.length;

        if (archivedStudents.length) {
            studentListEl.innerHTML = archivedStudents.sort((a, b) => ((b.data().archivedAt || '').localeCompare(a.data().archivedAt || ''))).map(d => {
                const s = d.data();
                return `
                <div class="archive-student-row flex flex-wrap items-center justify-between bg-white border border-[#dce3ed] hover:border-[#b8c5d4] rounded-xl p-4 mb-3 gap-3 shadow-sm transition">
                    <div class="flex-1 min-w-0">
                        <p class="font-bold text-[#0d1f35] text-[14px] m-0">${escHtml(s.name) || 'Unnamed'}</p>
                        <p class="text-[11.5px] text-[#6b84a0] font-medium mt-1 m-0">
                            ${s.className ? `<span class="font-bold text-[#374f6b]">Class: ${escHtml(s.className)}</span> · ` : ''}Archived ${s.archivedAt ? new Date(s.archivedAt).toLocaleDateString() : '—'}
                            ${s.archiveReason ? `<br><span class="text-[#b45309] font-bold mt-1 inline-block"><i class="fa-solid fa-clock-rotate-left mr-1"></i>Reason: ${escHtml(s.archiveReason)}</span>` : ''}
                        </p>
                    </div>
                    <div class="flex gap-2 flex-shrink-0">
                        <button onclick="printStudentRecord('${d.id}')" class="text-[11px] font-bold text-[#374f6b] hover:bg-[#f8fafb] border border-[#c5d0db] hover:border-[#0d1f35] bg-white px-3 py-1.5 rounded transition flex items-center gap-1.5 shadow-sm"><i class="fa-solid fa-print"></i> Print</button>
                        <button onclick="restoreStudent('${d.id}')" class="text-[11px] font-bold text-[#0ea871] hover:bg-[#0ea871] hover:text-white border border-[#c6f0db] bg-white px-3 py-1.5 rounded transition shadow-sm">Restore</button>
                        <button onclick="permanentDeleteStudent('${d.id}', '${escHtml(s.name).replace(/'/g, "\\'")}')" class="text-[11px] font-bold text-[#e31b4a] hover:bg-[#e31b4a] hover:text-white border border-[#fecaca] bg-white px-3 py-1.5 rounded transition shadow-sm">Delete</button>
                    </div>
                </div>`;
            }).join('');
        } else {
            studentListEl.innerHTML = '<div class="text-center py-10 bg-[#f8fafb] rounded border border-dashed border-[#b8c5d4]"><p class="text-[13px] text-[#6b84a0] font-bold m-0">No archived students.</p></div>';
        }
    } catch (e) {
        console.error('[Archives] Error loading students:', e);
        studentListEl.innerHTML = '<p class="text-[13px] text-[#e31b4a] font-bold text-center py-4 bg-[#fff0f3] rounded border border-[#fecaca]">Error loading archived students.</p>';
    }

    const archivedSubjects = getArchivedSubjects();
    const subjCountEl = document.getElementById('archivesSubjCount');
    if (subjCountEl) subjCountEl.textContent = archivedSubjects.length;

    if (archivedSubjects.length) {
        subjectListEl.innerHTML = archivedSubjects.sort((a, b) => ((b.archivedAt || '').localeCompare(a.archivedAt || ''))).map(s => `
        <div class="archive-subj-row flex flex-wrap items-center justify-between bg-white border border-[#dce3ed] hover:border-[#b8c5d4] rounded-xl p-4 mb-3 gap-3 shadow-sm transition">
            <div class="flex-1 min-w-0">
                <p class="font-bold text-[#6b84a0] text-[14px] line-through decoration-[#b8c5d4] m-0">${escHtml(s.name)}</p>
                <p class="text-[11.5px] text-[#9ab0c6] font-medium mt-1 m-0">Archived ${s.archivedAt ? new Date(s.archivedAt).toLocaleDateString() : '—'} · All existing grades preserved</p>
            </div>
            <div class="flex gap-2 flex-shrink-0">
                <button onclick="restoreSubject('${s.id}')" class="text-[11px] font-bold text-[#0ea871] hover:bg-[#0ea871] hover:text-white border border-[#c6f0db] bg-white px-3 py-1.5 rounded transition shadow-sm">Restore</button>
                <button onclick="permanentDeleteSubject('${s.id}', '${escHtml(s.name).replace(/'/g, "\\'")}')" class="text-[11px] font-bold text-[#e31b4a] hover:bg-[#e31b4a] hover:text-white border border-[#fecaca] bg-white px-3 py-1.5 rounded transition shadow-sm">Delete</button>
            </div>
        </div>`).join('');
    } else {
        subjectListEl.innerHTML = '<div class="text-center py-10 bg-[#f8fafb] rounded border border-dashed border-[#b8c5d4]"><p class="text-[13px] text-[#6b84a0] font-bold m-0">No archived subjects.</p></div>';
    }
}

window.filterArchivedStudents = function() {
    const term = document.getElementById('archiveStudentSearch').value.toLowerCase();
    document.querySelectorAll('.archive-student-row').forEach(row => {
        row.style.display = row.textContent.toLowerCase().includes(term) ? '' : 'none';
    });
};

// ── 5. STUDENT ACTIONS ──────────────────────────────────────────────────────
window.restoreStudent = async function(id) {
    try {
        // CHANGED: update global student doc
        await updateDoc(doc(db, 'students', id), {
            enrollmentStatus: 'Active',
            currentSchoolId:  session.schoolId,
            teacherId:        session.teacherId
        });
        loadArchivesTab(); 
    } catch (e) {
        console.error('[Archives] Error restoring student:', e);
        alert("Error restoring student.");
    }
};

window.permanentDeleteStudent = async function(id, studentName) {
    if (!confirm(`Permanently delete ${studentName} and ALL their grades?\n\nWARNING: This action CANNOT be undone.`)) return;
    
    try {
        // Grades still at siloed path; student doc now global
        const gradesSnap = await getDocs(collection(db, 'students', id, 'grades'));
        const batch = writeBatch(db);
        gradesSnap.forEach(d => batch.delete(d.ref));
        if (!gradesSnap.empty) { await batch.commit(); }
        // CHANGED: delete from global /students
        await deleteDoc(doc(db, 'students', id));
        loadArchivesTab(); 
    } catch (e) {
        console.error('[Archives] Deletion error:', e);
        alert("Failed to permanently delete student data.");
    }
};

// ── 6. SUBJECT ACTIONS ──────────────────────────────────────────────────────
window.restoreSubject = async function(subjectId) {
    const newSubs = session.teacherData.subjects.map(s => 
        s.id === subjectId ? { ...s, archived: false, archivedAt: null } : s
    );
    
    try {
        // CHANGED: use getTeacherRef() for global/legacy compatibility
        await updateDoc(getTeacherRef(), { subjects: newSubs });
        session.teacherData.subjects = newSubs;
        setSessionData('teacher', session);
        loadArchivesTab();
    } catch (e) {
        console.error('[Archives] Error restoring subject:', e);
        alert('Error restoring subject.');
    }
};

window.permanentDeleteSubject = async function(subjectId, subjectName) {
    const sub = (session.teacherData.subjects || []).find(s => s.id === subjectId);
    if (!sub) return;
    
    if (!confirm(`Permanently delete "${subjectName}"?\n\nWARNING: Existing student grades will still reference this subject name text, but the subject will be removed from your curriculum lists entirely.`)) return;
    
    const newSubs = session.teacherData.subjects.filter(s => s.id !== subjectId);
    try {
        await updateDoc(getTeacherRef(), { subjects: newSubs });
        session.teacherData.subjects = newSubs;
        setSessionData('teacher', session);
        loadArchivesTab();
    } catch (e) {
        console.error('[Archives] Error deleting subject:', e);
        alert('Error deleting subject permanently.');
    }
};

// ── 7. PRINT RECORD LOGIC ───────────────────────────────────────────────────
window.printStudentRecord = function(studentId) {
    currentStudentId = studentId;
    
    const psSubj = document.getElementById('psSubject');
    const allSubjects = session.teacherData.subjects || [];
    psSubj.innerHTML = '<option value="all">All Subjects</option>' + allSubjects.map(s => `<option value="${escHtml(s.name)}">${escHtml(s.name)}</option>`).join('');
    
    openOverlay('printStudentModal', 'printStudentModalInner');
};

window.executeStudentPrint = async function() {
    const mode = document.getElementById('psMode').value;
    const subjFilter = document.getElementById('psSubject').value;
    const studentId = currentStudentId;
    
    try {
        // CHANGED: student doc from global /students
        const sDoc = await getDoc(doc(db, 'students', studentId));
        if (!sDoc.exists()) { alert('Student not found.'); return; }
        
        const s = sDoc.data();
        const gradesSnap = await getDocs(collection(db, 'students', studentId, 'grades'));
        
        let grades = [];
        gradesSnap.forEach(d => grades.push(d.data()));
        
        const bySem = {};
        grades.forEach(g => {
            if (subjFilter !== 'all' && g.subject !== subjFilter) return;
            const sem = rawSemesters.find(sm => sm.id === g.semesterId)?.name || 'Unknown Period';
            const sub = g.subject || 'Uncategorized';
            
            if (!bySem[sem]) bySem[sem] = {};
            if (!bySem[sem][sub]) bySem[sem][sub] = [];
            bySem[sem][sub].push(g);
        });
        
        let html = `<html><head><title>Student Record - ${escHtml(s.name)}</title>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
            body { font-family: 'DM Sans', sans-serif; padding: 40px; color: #0d1f35; line-height: 1.5; background: white; }
            .header { display: flex; flex-direction: column; align-items: center; border-bottom: 2px solid #0d1f35; padding-bottom: 20px; margin-bottom: 24px; }
            .logo { max-height: 50px; max-width: 180px; object-fit: contain; margin-bottom: 12px; }
            .header h1 { margin: 0 0 5px 0; font-size: 22px; color: #0d1f35; text-transform: uppercase; letter-spacing: 1px; font-weight: 700; }
            .header h2 { margin: 0; font-size: 11px; color: #6b84a0; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; }
            .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 40px; background: #f8fafb; padding: 20px; border-radius: 4px; border: 1px solid #dce3ed; }
            .info-item label { display: block; font-size: 10px; text-transform: uppercase; color: #6b84a0; font-weight: 700; letter-spacing: 1px; margin-bottom: 4px; }
            .info-item span { font-size: 14px; font-weight: 700; color: #0d1f35; }
            .sem-block { margin-bottom: 40px; page-break-inside: avoid; }
            .sem-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; background: #0d1f35; color: white; padding: 8px 14px; margin: 0 0 15px 0; border-radius: 2px; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 13px; }
            th, td { border: 1px solid #dce3ed; padding: 10px 14px; text-align: left; }
            th { background: #f8fafb; color: #6b84a0; font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; }
            .tc { text-align: center; } .tr { text-align: right; }
            .avg-row { background: #f0f4f8; font-weight: 700; }
        </style></head><body>
        <div class="header">
            <img src="${session.logo || ''}" alt="${escHtml(session.schoolName || session.schoolId)}" class="logo" onerror="this.style.display='none'">
            <h1>Official Academic Record</h1>
            <h2>${mode === 'summary' ? 'REPORT CARD SUMMARY' : 'DETAILED TRANSCRIPT'}</h2>
        </div>
        <div class="info-grid">
            <div class="info-item"><label>Student Name</label><span>${escHtml(s.name)}</span></div>
            <div class="info-item"><label>Status</label><span style="color:#e31b4a;">${s.archived ? 'Archived / Transferred' : 'Active'}</span></div>
            <div class="info-item"><label>Last Known Class</label><span>${escHtml(s.className) || 'Unassigned'}</span></div>
            <div class="info-item"><label>Teacher</label><span>${escHtml(session.teacherData.name)}</span></div>
        </div>`;
        
        if (!Object.keys(bySem).length) {
            html += `<p style="text-align:center;color:#6b84a0;font-style:italic;padding:40px;">No grades recorded matching filters.</p>`;
        } else {
            for (let sem in bySem) {
                html += `<div class="sem-block"><h3 class="sem-title">${escHtml(sem)}</h3><table>`;
                if (mode === 'summary') {
                    html += `<thead><tr><th>Subject</th><th class="tc">Assignments</th><th class="tc">Average (%)</th><th class="tc">Letter Grade</th></tr></thead><tbody>`;
                    let semTotalPct = 0; let semSubjCount = 0;
                    for (let sub in bySem[sem]) {
                        const sGrades = bySem[sem][sub];
                        // UPDATED: Using Teacher-Specific Grade Types
                        const avg = calculateWeightedAverage(sGrades, getGradeTypes());
                        if (avg !== null) {
                            semTotalPct += avg; semSubjCount++;
                            html += `<tr><td>${escHtml(sub)}</td><td class="tc">${sGrades.length}</td><td class="tc font-mono font-bold">${avg}%</td><td class="tc font-bold">${letterGrade(avg)}</td></tr>`;
                        }
                    }
                    if (semSubjCount > 0) {
                        const semAvg = Math.round(semTotalPct / semSubjCount);
                        html += `<tr class="avg-row"><td colspan="2" class="tr text-[10px] text-[#6b84a0] uppercase tracking-wider">Period Average</td><td class="tc font-mono font-bold text-[#0d1f35]">${semAvg}%</td><td class="tc font-bold text-[#0d1f35]">${letterGrade(semAvg)}</td></tr>`;
                    }
                    html += `</tbody></table></div>`;
                } else {
                    html += `<thead><tr><th>Subject</th><th>Assignment</th><th>Type</th><th class="tc">Score</th><th class="tc">%</th></tr></thead><tbody>`;
                    for (let sub in bySem[sem]) {
                        const sGrades = bySem[sem][sub].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
                        sGrades.forEach(g => {
                            const pct = g.max ? Math.round(g.score / g.max * 100) : null;
                            html += `<tr><td>${escHtml(sub)}</td><td>${escHtml(g.title)}<br><span style="font-size:10px;color:#9ab0c6">${escHtml(g.date) || ''}</span></td><td>${escHtml(g.type)}</td><td class="tc font-mono">${g.score}/${g.max}</td><td class="tc font-bold">${pct !== null ? pct + '%' : '—'}</td></tr>`;
                        });
                    }
                    html += `</tbody></table></div>`;
                }
            }
        }
        
        // UPDATED: Branded Footer Disclaimer
        const printDisclaimer = `
        <div style='font-size:10px;color:#9ab0c6;margin-top:40px;text-align:center;border-top:1px solid #dce3ed;padding-top:14px;font-style:italic;'>
            <p style="margin:0 0 10px 0;">Generated by the ConnectUs Analytical Engine for ${escHtml(session.schoolName || session.schoolId)}. This document does not constitute a certified administrative transcript unless signed and stamped by school administration.</p>
            <div style="display:flex; justify-content:center; align-items:center; gap:8px;">
                <img src="../../assets/images/logo.png" style="max-height:16px; object-fit:contain; opacity:0.8;">
                <span style="font-weight:bold; color:#0d1f35; font-style:normal;">Powered by ConnectUs</span>
            </div>
        </div>`;
        
        html += printDisclaimer + `</body></html>`;
        
        const w = window.open('', '_blank');
        w.document.write(html);
        w.document.close();
        
        closeOverlay('printStudentModal', 'printStudentModalInner');
        setTimeout(() => w.print(), 600);
        
    } catch (e) {
        console.error('[Archives] Error generating print:', e);
        alert('Error generating print.');
    }
}

// Fire it up
init();
