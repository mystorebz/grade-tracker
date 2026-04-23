import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { openOverlay, closeOverlay, showMsg, gradeColorClass, gradeFill, letterGrade, downloadCSV } from '../../assets/js/utils.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('gradebook', 'Gradebook', 'Complete grade record for the selected period', false);
}

// ── 2. STATE VARIABLES ──────────────────────────────────────────────────────
let allStudentsCache = [];
let allGradesCache = null;
let studentMap = {};
let gradeDetailCache = {};
let rawSemesters = [];
let isSemesterLocked = false;
let currentEditData = null;
let originalScore = null;
let originalMax = null;

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];
function getGradeTypes() { return session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES; }

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    // Load Sidebar Data
    document.getElementById('displayTeacherName').textContent = session.teacherData.name;
    document.getElementById('teacherAvatar').textContent = session.teacherData.name.charAt(0).toUpperCase();
    document.getElementById('sidebarSchoolId').textContent = session.schoolId;

    const classes = session.teacherData.classes || [session.teacherData.className || ''];
    document.getElementById('displayTeacherClasses').innerHTML = classes.map(c => `<span class="class-pill">${c}</span>`).join('');

    // Attach Listeners
    document.getElementById('updateGradeBtn').addEventListener('click', saveEditedGrade);

    // Populate Type filter early based on teacher data
    const typeSel = document.getElementById('gbFilterType');
    typeSel.innerHTML = '<option value="">All Types</option>' + getGradeTypes().map(t => `<option value="${t}">${t}</option>`).join('');

    await loadSemestersAndLockStatus();
    await loadStudents();
    await loadGradebook();
}

async function loadSemestersAndLockStatus() {
    try {
        const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId = schoolSnap.data()?.activeSemesterId || '';

        rawSemesters = semSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));

        const semSel = document.getElementById('activeSemester');
        semSel.innerHTML = '';
        rawSemesters.forEach(s => {
            semSel.innerHTML += `<option value="${s.id}"${s.id === activeId ? ' selected' : ''}>${s.name}</option>`;
        });

        checkLockStatus();

        semSel.addEventListener('change', () => {
            checkLockStatus();
            allGradesCache = null; // Clear cache on semester swap
            loadGradebook();
        });
    } catch (e) {
        console.error("Error loading semesters:", e);
    }
}

function checkLockStatus() {
    const semId = document.getElementById('activeSemester').value;
    const activeSem = rawSemesters.find(s => s.id === semId);
    isSemesterLocked = activeSem ? !!activeSem.isLocked : false;
    
    const badge = document.getElementById('topbarLockedBadge');
    if (badge) {
        isSemesterLocked ? badge.classList.remove('hidden') : badge.classList.add('hidden');
        isSemesterLocked ? badge.classList.add('flex') : badge.classList.remove('flex');
    }
}

async function loadStudents() {
    try {
        // We load all active students assigned to this teacher to match against the grades
        const stuQuery = query(collection(db, 'schools', session.schoolId, 'students'), where('archived', '==', false), where('teacherId', '==', session.teacherId));
        const stuSnap = await getDocs(stuQuery);
        allStudentsCache = stuSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        studentMap = {};
        allStudentsCache.forEach(s => { studentMap[s.id] = s.name; });

        // Update topbar filter dropdown
        const gbSel = document.getElementById('gbFilterStudent');
        gbSel.innerHTML = '<option value="">All Students</option>';
        allStudentsCache.sort((a, b) => a.name.localeCompare(b.name)).forEach(s => {
            gbSel.innerHTML += `<option value="${s.id}">${s.name}</option>`;
        });
    } catch (e) { console.error("Error loading students:", e); }
}

async function getAllGrades(semId) {
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

// ── 4. RENDER GRADEBOOK ─────────────────────────────────────────────────────
async function loadGradebook() {
    const tbody = document.getElementById('gradebookTableBody');
    tbody.innerHTML = `<tr><td colspan="7" class="px-6 py-16 text-center text-slate-400 font-semibold"><i class="fa-solid fa-spinner fa-spin text-slate-400 text-2xl mb-3 block"></i>Loading gradebook...</td></tr>`;
    
    const semId = document.getElementById('activeSemester').value;
    if (!allStudentsCache.length) await loadStudents();
    await getAllGrades(semId);
    
    // Dynamically populate Subject Filter based on grades present in this semester
    const subjSet = new Set(allGradesCache.grades.map(g => g.subject || 'Uncategorized'));
    const subjSel = document.getElementById('gbFilterSubject');
    if (subjSel) {
        const prev = subjSel.value;
        subjSel.innerHTML = '<option value="">All Subjects</option>';
        [...subjSet].sort().forEach(s => {
            subjSel.innerHTML += `<option${s === prev ? ' selected' : ''}>${s}</option>`;
        });
    }
    
    renderGradebook();
}

function renderGradebook() {
    const tbody = document.getElementById('gradebookTableBody');
    
    // Get filter values
    const fs = document.getElementById('gbFilterStudent')?.value || '';
    const fsub = document.getElementById('gbFilterSubject')?.value || '';
    const ftype = document.getElementById('gbFilterType')?.value || '';
    const fText = (document.getElementById('gbSearchInput')?.value || '').toLowerCase();
    
    let rows = allGradesCache?.grades || [];
    
    // Apply filters
    if (fs) rows = rows.filter(g => g.studentId === fs);
    if (fsub) rows = rows.filter(g => g.subject === fsub);
    if (ftype) rows = rows.filter(g => g.type === ftype);
    if (fText) rows = rows.filter(g => (g.title || '').toLowerCase().includes(fText));
    
    document.getElementById('gbRecordCount').innerHTML = `<span class="text-xs font-black text-emerald-700">${rows.length} record${rows.length !== 1 ? 's' : ''}</span>`;
    
    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="px-6 py-16 text-center text-slate-400 italic font-semibold">No grades found for the selected filters.</td></tr>`;
        return;
    }

    gradeDetailCache = {}; // Reset cache

    tbody.innerHTML = rows.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(g => {
        gradeDetailCache[g.id] = g;
        
        const pct = g.max ? Math.round(g.score / g.max * 100) : null;
        const gc = gradeColorClass(pct || 0);
        const letter = pct !== null ? letterGrade(pct) : '—';
        const badgeBg = pct >= 90 ? 'bg-emerald-50 border-emerald-200' : pct >= 80 ? 'bg-blue-50 border-blue-200' : pct >= 70 ? 'bg-teal-50 border-teal-200' : pct >= 65 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200';
        
        return `
        <tr class="gb-row">
            <td class="px-6 py-4">
                <div class="flex items-center gap-3">
                    <div class="h-9 w-9 bg-gradient-to-br from-emerald-400 to-teal-500 text-white rounded-lg flex items-center justify-center font-black text-xs flex-shrink-0">${g.studentName.charAt(0)}</div>
                    <span class="font-black text-slate-700 text-sm">${g.studentName}</span>
                </div>
            </td>
            <td class="px-6 py-4"><span class="text-xs font-black bg-teal-100 text-teal-700 border border-teal-200 px-2.5 py-1 rounded-lg">${g.subject || '—'}</span></td>
            <td class="px-6 py-4">
                <p class="font-bold text-slate-700 text-sm">${g.title || '—'}</p>
                <p class="text-xs text-slate-400 font-semibold">${g.date || ''}</p>
            </td>
            <td class="px-6 py-4"><span class="text-[10px] font-black uppercase tracking-wider bg-slate-100 text-slate-500 border border-slate-200 px-2 py-1 rounded-md">${g.type || '—'}</span></td>
            <td class="px-6 py-4 text-center font-bold text-slate-600 text-sm">${g.score} / ${g.max || '?'}</td>
            <td class="px-6 py-4 text-center">
                <span class="font-black text-xs px-2.5 py-1 rounded-lg border ${gc} ${badgeBg}">${pct !== null ? pct + '% · ' + letter : '—'}</span>
            </td>
            <td class="px-6 py-4 text-right">
                <div class="flex items-center justify-end gap-1">
                    <button onclick="openAssignmentModal('${g.id}')" class="h-8 w-8 bg-slate-50 hover:bg-slate-500 hover:text-white text-slate-500 rounded-lg transition border border-slate-200 hover:border-slate-500 flex items-center justify-center" title="View"><i class="fa-solid fa-eye text-xs"></i></button>
                    ${isSemesterLocked ? 
                        `<span class="text-[10px] text-slate-400 font-black uppercase tracking-widest ml-1"><i class="fa-solid fa-lock"></i></span>` : 
                        `<button onclick="openEditGradeModal('${g.studentId}','${g.id}')" class="h-8 w-8 bg-amber-50 hover:bg-amber-500 hover:text-white text-amber-600 rounded-lg transition border border-amber-200 hover:border-amber-500 flex items-center justify-center" title="Edit"><i class="fa-solid fa-pen text-xs"></i></button>
                         <button onclick="deleteGrade('${g.studentId}','${g.id}')" class="h-8 w-8 bg-red-50 hover:bg-red-500 hover:text-white text-red-400 rounded-lg transition border border-red-100 hover:border-red-500 flex items-center justify-center" title="Delete"><i class="fa-solid fa-trash-can text-xs"></i></button>`
                    }
                </div>
            </td>
        </tr>`;
    }).join('');
}

window.applyGradebookFilters = function() {
    renderGradebook();
};

// ── 5. VIEW ASSIGNMENT MODAL ────────────────────────────────────────────────
window.openAssignmentModal = function(gradeId) {
    const g = gradeDetailCache[gradeId];
    if (!g) return;
    
    const pct = g.max ? Math.round(g.score / g.max * 100) : null;
    const fill = gradeFill(pct || 0);
    const color = pct >= 90 ? 'text-emerald-600' : pct >= 80 ? 'text-blue-600' : pct >= 70 ? 'text-teal-600' : pct >= 65 ? 'text-amber-600' : 'text-red-600';
    
    document.getElementById('aModalTitle').textContent = g.title || 'Assessment';
    
    let histHTML = '';
    if (g.historyLogs?.length) {
        histHTML = `<div class="bg-amber-50 border border-amber-200 rounded-xl p-4"><p class="text-xs font-black text-amber-600 uppercase tracking-wider mb-2"><i class="fa-solid fa-clock-rotate-left mr-1"></i>Edit History (${g.historyLogs.length})</p><div class="space-y-2 max-h-32 overflow-y-auto">${g.historyLogs.map(l => `<div class="text-xs text-amber-800 font-semibold bg-white rounded-lg p-2 border border-amber-100"><i class="fa-solid fa-circle-dot mr-1 text-amber-400"></i>${typeof l === 'object' ? `[${l.changedAt}] ${l.oldScore}/${l.oldMax} → ${l.newScore}/${l.newMax}. Reason: ${l.reason}` : l}</div>`).join('')}</div></div>`;
    }
    
    document.getElementById('aModalBody').innerHTML = `
        <div class="text-center mb-5">
            <div class="${color} text-5xl font-black">${g.score}<span class="text-2xl text-slate-400">/${g.max || '?'}</span></div>
            ${pct !== null ? `<div class="flex items-center justify-center gap-3 mt-2"><span class="${color} text-xl font-black">${pct}%</span><span class="${color} font-black px-3 py-1 rounded-xl text-lg border ${pct >= 90 ? 'bg-emerald-50 border-emerald-200' : pct >= 80 ? 'bg-blue-50 border-blue-200' : pct >= 70 ? 'bg-teal-50 border-teal-200' : pct >= 65 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}">${letterGrade(pct)}</span></div>` : ''}
            <div class="mt-3 h-3 bg-slate-100 rounded-full overflow-hidden mx-4"><div class="h-full rounded-full" style="width:${pct || 0}%;background:${fill};transition:width 0.5s ease"></div></div>
        </div>
        <div class="space-y-2 text-sm mb-4">
            ${[['Subject', g.subject || '—'], ['Type', g.type || '—'], ['Date', g.date || '—']].map(([l, v]) => `<div class="flex justify-between py-2 border-b border-slate-100"><span class="text-slate-400 font-black uppercase text-xs tracking-wider">${l}</span><span class="font-black text-slate-700">${v}</span></div>`).join('')}
        </div>
        ${g.notes ? `<div class="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-3"><p class="text-xs font-black text-blue-500 uppercase tracking-wider mb-1">Teacher Notes</p><p class="text-sm text-slate-700 font-semibold whitespace-pre-wrap">${g.notes}</p></div>` : ''}
        ${histHTML}
    `;
    
    openOverlay('assignmentModal', 'assignmentModalInner');
};
window.closeAssignmentModal = function() { closeOverlay('assignmentModal', 'assignmentModalInner'); };

// ── 6. EDIT GRADE MODAL ─────────────────────────────────────────────────────
window.openEditGradeModal = async function(studentId, gradeId) {
    if (isSemesterLocked) return;
    
    try {
        const snap = await getDoc(doc(db, 'schools', session.schoolId, 'students', studentId, 'grades', gradeId));
        if (!snap.exists()) return;
        
        currentEditData = { studentId, gradeId, ...snap.data() };
        originalScore = currentEditData.score;
        originalMax = currentEditData.max;
        
        document.getElementById('editGradeContext').textContent = `${studentMap[studentId] || 'Student'} · ${currentEditData.subject || ''} · ${currentEditData.title || ''}`;
        
        const oldNotesEl = document.getElementById('ed-old-notes');
        if (currentEditData.notes) {
            oldNotesEl.textContent = currentEditData.notes;
            oldNotesEl.parentElement.classList.remove('hidden');
        } else {
            oldNotesEl.parentElement.classList.add('hidden');
        }
        
        document.getElementById('ed-new-notes').value = '';
        document.getElementById('ed-score').value = currentEditData.score;
        document.getElementById('ed-max').value = currentEditData.max;
        
        document.getElementById('ed-reason').value = '';
        document.getElementById('reasonSection').classList.remove('visible');
        document.getElementById('editGradeMsg').classList.add('hidden');
        
        openOverlay('editGradeModal', 'editGradeModalInner');
    } catch (e) {
        console.error(e);
        alert("Error loading grade details.");
    }
};

window.closeEditGradeModal = function() { closeOverlay('editGradeModal', 'editGradeModalInner'); };

window.checkScoreChange = function() {
    const s = parseFloat(document.getElementById('ed-score')?.value);
    const m = parseFloat(document.getElementById('ed-max')?.value);
    const hasChanged = (s !== originalScore || m !== originalMax);
    
    document.getElementById('reasonSection').classList.toggle('visible', hasChanged);
};

async function saveEditedGrade() {
    const nScore = parseFloat(document.getElementById('ed-score').value);
    const nMax = parseFloat(document.getElementById('ed-max').value);
    const appendedNote = document.getElementById('ed-new-notes').value.trim();
    const scoreChanged = (nScore !== originalScore || nMax !== originalMax);
    
    if (scoreChanged) {
        const reason = document.getElementById('ed-reason').value.trim();
        if (!reason) {
            alert('A reason is required when changing the score to preserve auditing trails.');
            document.getElementById('ed-reason').focus();
            return;
        }
    }
    
    const btn = document.getElementById('updateGradeBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;
    
    try {
        let finalNotes = currentEditData.notes || '';
        if (appendedNote) {
            const ts = `[${new Date().toLocaleDateString()}] ${appendedNote}`;
            finalNotes = finalNotes ? `${ts}\n\n${finalNotes}` : ts;
        }
        
        const updates = { notes: finalNotes, score: nScore, max: nMax };
        
        if (scoreChanged) {
            const reason = document.getElementById('ed-reason').value.trim();
            updates.historyLogs = [
                ...(currentEditData.historyLogs || []),
                { changedAt: new Date().toLocaleString(), oldScore: originalScore, oldMax: originalMax, newScore: nScore, newMax: nMax, reason }
            ];
        }
        
        await updateDoc(doc(db, 'schools', session.schoolId, 'students', currentEditData.studentId, 'grades', currentEditData.gradeId), updates);
        
        closeEditGradeModal();
        allGradesCache = null; // force reload to get updated data
        loadGradebook();
    } catch (e) {
        console.error(e);
        showMsg('editGradeMsg', 'Error saving changes.', true);
    }
    
    btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Changes`;
    btn.disabled = false;
}

// ── 7. DELETE GRADE ─────────────────────────────────────────────────────────
window.deleteGrade = async function(studentId, gradeId) {
    if (isSemesterLocked) return;
    
    if (!confirm('Are you sure you want to permanently delete this grade?')) return;
    
    try {
        await deleteDoc(doc(db, 'schools', session.schoolId, 'students', studentId, 'grades', gradeId));
        allGradesCache = null; // clear cache to refresh
        loadGradebook();
    } catch (e) {
        console.error(e);
        alert("Failed to delete grade.");
    }
};

// ── 8. EXPORT & PRINT ───────────────────────────────────────────────────────
window.exportGradebookCSV = function() {
    const fs = document.getElementById('gbFilterStudent')?.value || '';
    const fsub = document.getElementById('gbFilterSubject')?.value || '';
    const ftype = document.getElementById('gbFilterType')?.value || '';
    const fText = (document.getElementById('gbSearchInput')?.value || '').toLowerCase();
    
    let rows = allGradesCache?.grades || [];
    if (fs) rows = rows.filter(g => g.studentId === fs);
    if (fsub) rows = rows.filter(g => g.subject === fsub);
    if (ftype) rows = rows.filter(g => g.type === ftype);
    if (fText) rows = rows.filter(g => (g.title || '').toLowerCase().includes(fText));
    
    downloadCSV([
        ['Student', 'Subject', 'Assignment', 'Type', 'Date', 'Score', 'Max', '%', 'Letter', 'Notes'],
        ...rows.map(g => {
            const p = g.max ? Math.round(g.score / g.max * 100) : null;
            return [
                g.studentName, g.subject || '', g.title || '', g.type || '', g.date || '',
                g.score, g.max || '', p !== null ? p + '%' : '', p !== null ? letterGrade(p) : '', g.notes || ''
            ];
        })
    ], `${session.schoolId}_gradebook.csv`);
};

window.printGradebook = function() {
    const fs = document.getElementById('gbFilterStudent')?.value || '';
    const fsub = document.getElementById('gbFilterSubject')?.value || '';
    const ftype = document.getElementById('gbFilterType')?.value || '';
    const fText = (document.getElementById('gbSearchInput')?.value || '').toLowerCase();
    
    let rows = allGradesCache?.grades || [];
    if (fs) rows = rows.filter(g => g.studentId === fs);
    if (fsub) rows = rows.filter(g => g.subject === fsub);
    if (ftype) rows = rows.filter(g => g.type === ftype);
    if (fText) rows = rows.filter(g => (g.title || '').toLowerCase().includes(fText));
    
    const w = window.open('', '_blank');
    w.document.write(`
        <html><head><title>Gradebook</title>
        <style>body{font-family:sans-serif;padding:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #e2e8f0;padding:6px 10px;font-size:12px;text-align:left}th{background:#064e3b;color:white;font-weight:700}.hi{color:#15803d}.mid{color:#92400e}.lo{color:#991b1b}</style>
        </head><body>
        <h2>${session.teacherData.name} — Gradebook (${document.getElementById('activeSemester').options[document.getElementById('activeSemester').selectedIndex]?.text || ''})</h2>
        <p style="color:#64748b;font-size:12px;margin-bottom:16px">Printed ${new Date().toLocaleDateString()} · ${rows.length} records</p>
        <table><thead><tr><th>Student</th><th>Subject</th><th>Assignment</th><th>Type</th><th>Date</th><th>Score</th><th>%</th><th>Grade</th></tr></thead>
        <tbody>
        ${rows.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(g => {
            const p = g.max ? Math.round(g.score / g.max * 100) : null;
            const cls = p >= 75 ? 'hi' : p >= 65 ? 'mid' : 'lo';
            return `<tr><td>${g.studentName}</td><td>${g.subject || '—'}</td><td>${g.title || '—'}</td><td>${g.type || '—'}</td><td>${g.date || '—'}</td><td>${g.score}/${g.max || '?'}</td><td class="${cls}">${p !== null ? p + '%' : '—'}</td><td class="${cls}">${p !== null ? letterGrade(p) : '—'}</td></tr>`;
        }).join('')}
        </tbody></table>
        <p style='font-size:10px;color:#64748b;margin-top:40px;text-align:center;border-top:1px solid #e2e8f0;padding-top:10px;font-style:italic;'>This document is automatically generated by ConnectUs Data Services.</p>
        </body></html>
    `);
    w.document.close();
    setTimeout(() => w.print(), 500);
};

// Fire it up
init();
