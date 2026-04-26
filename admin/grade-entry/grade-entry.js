import { db } from '../../assets/js/firebase-init.js';
import {
    doc, getDoc, getDocs, addDoc, updateDoc, collection, query, where, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { letterGrade, openOverlay, closeOverlay } from '../../assets/js/utils.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('grade-entry', 'Grade Management', 'Oversee class performance and manage administrative grade overrides.', false, false);

// ── 2. STATE ──────────────────────────────────────────────────────────────
let rawSemesters  = [];
let currentRoster = []; 
let currentGrades = []; 
window.targetStudent = null; 
window.editGradeMode = false;
window.editGradeId   = null;
window.editGradeOldData = null;

// ── 3. INIT ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('agDate').valueAsDate = new Date();

    await loadSemesters();
    populateClassOptions();
    await loadGradeTypes();

    // Event Listeners for Filters
    document.getElementById('filterSemester').addEventListener('change', loadRosterData);
    document.getElementById('filterClass').addEventListener('change', loadRosterData);
    document.getElementById('filterSubject').addEventListener('change', loadRosterData);
    document.getElementById('filterStudent').addEventListener('input', renderGrid);

    // Event Listeners for Grade Panel
    document.getElementById('agScore').addEventListener('input', updatePreview);
    document.getElementById('agMax').addEventListener('input', updatePreview);
    document.getElementById('saveGradeBtn').addEventListener('click', saveGrade);
});

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getClassOptions() {
    const type = (session.schoolType || '').toLowerCase();
    if (type === 'highschool' || type === 'secondary') {
        return ['First Form', 'Second Form', 'Third Form', 'Fourth Form', 'Fifth Form', 'Sixth Form'];
    } else if (type === 'juniorcollege' || type === 'tertiary') {
        return ['Year 1 — Semester 1', 'Year 1 — Semester 2', 'Year 2 — Semester 1', 'Year 2 — Semester 2'];
    }
    return ['Infant 1', 'Infant 2', 'Standard 1', 'Standard 2', 'Standard 3', 'Standard 4', 'Standard 5', 'Standard 6'];
}

function populateClassOptions() {
    const sel = document.getElementById('filterClass');
    sel.innerHTML = '<option value="">— Select Class —</option>' + 
        getClassOptions().map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
}

// ── 4. LOAD SEMESTERS & TYPES ─────────────────────────────────────────────
async function loadSemesters() {
    try {
        const snap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
        rawSemesters = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.order || 0) - (b.order || 0));

        let activeId = '';
        try {
            const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
            activeId = schoolSnap.data()?.activeSemesterId || '';
        } catch(e) {}

        const sel = document.getElementById('filterSemester');
        sel.innerHTML = '';
        rawSemesters.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.name;
            if (s.id === activeId) opt.selected = true;
            sel.appendChild(opt);
        });
    } catch (e) {
        console.error('[GradeManagement] loadSemesters:', e);
    }
}

async function loadGradeTypes() {
    const sel = document.getElementById('agType');
    try {
        const snap = await getDocs(collection(db, 'schools', session.schoolId, 'gradeTypes'));
        let types = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.order || 0) - (b.order || 0));

        if (!types.length) {
            types = [{ name: 'Test' }, { name: 'Quiz' }, { name: 'Assignment' }, { name: 'Homework' }, { name: 'Project' }, { name: 'Final Exam' }];
        }

        sel.innerHTML = '<option value="">Select type...</option>' +
            types.map(t => `<option value="${escHtml(t.name)}">${escHtml(t.name)}</option>`).join('');
    } catch (e) {
        console.error('[GradeManagement] loadGradeTypes:', e);
        sel.innerHTML = '<option value="">Test</option><option>Quiz</option><option>Assignment</option><option>Project</option><option>Final Exam</option>';
    }
}

// ── 5. ROSTER & GRADE FETCHING ────────────────────────────────────────────
async function loadRosterData() {
    const semId   = document.getElementById('filterSemester').value;
    const clsName = document.getElementById('filterClass').value;
    const subject = document.getElementById('filterSubject').value;
    const tbody   = document.getElementById('rosterTableBody');

    if (!clsName || !subject) {
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-20 text-center">
            <div class="inline-flex flex-col items-center justify-center">
                <i class="fa-solid fa-table-list text-4xl text-[#c5d0db] mb-3"></i>
                <p class="text-[14px] text-[#6b84a0] font-bold">Select a Class and Subject</p>
                <p class="text-[12px] text-[#9ab0c6] font-semibold mt-1">Use the filters above to load the grade roster.</p>
            </div>
        </td></tr>`;
        currentRoster = [];
        currentGrades = [];
        return;
    }

    tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-[#9ab0c6] italic font-semibold">
        <i class="fa-solid fa-spinner fa-spin mr-2 text-[#2563eb]"></i>Compiling national records...
    </td></tr>`;

    try {
        const studentSnap = await getDocs(query(
            collection(db, 'students'),
            where('currentSchoolId', '==', session.schoolId),
            where('className', '==', clsName),
            where('enrollmentStatus', '==', 'Active')
        ));
        
        currentRoster = studentSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        if (!currentRoster.length) {
            tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-[#9ab0c6] italic font-semibold">No active students found in ${escHtml(clsName)}.</td></tr>`;
            return;
        }

        const gradePromises = currentRoster.map(s => 
            getDocs(query(
                collection(db, 'schools', session.schoolId, 'students', s.id, 'grades'),
                where('semesterId', '==', semId),
                where('subject', '==', subject)
            ))
        );

        const gradeResults = await Promise.all(gradePromises);
        currentGrades = [];
        gradeResults.forEach((snap, idx) => {
            snap.forEach(d => {
                currentGrades.push({ id: d.id, studentId: currentRoster[idx].id, ...d.data() });
            });
        });

        renderGrid();

    } catch (e) {
        console.error('[GradeManagement] loadRosterData:', e);
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-[#e31b4a] font-semibold">System error pulling records.</td></tr>`;
    }
}

// ── 6. RENDER GRID ────────────────────────────────────────────────────────
function renderGrid() {
    const term  = (document.getElementById('filterStudent').value || '').toLowerCase();
    const tbody = document.getElementById('rosterTableBody');

    let filteredRoster = currentRoster;
    if (term) {
        filteredRoster = filteredRoster.filter(s => 
            (s.name || '').toLowerCase().includes(term) || 
            (s.id || '').toLowerCase().includes(term)
        );
    }

    if (!filteredRoster.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-[#9ab0c6] italic font-semibold">No matching students found.</td></tr>`;
        return;
    }

    const calcLg = (avg) => avg >= 90 ? 'A' : avg >= 80 ? 'B' : avg >= 70 ? 'C' : avg >= 60 ? 'D' : 'F';

    tbody.innerHTML = filteredRoster.map(s => {
        const sGrades = currentGrades.filter(g => g.studentId === s.id);
        
        let avgStr = '--';
        let lgStr  = '--';
        let avgCol = 'text-[#6b84a0] bg-[#f8fafb] border-[#dce3ed]';

        if (sGrades.length > 0) {
            const avgNum = sGrades.reduce((a, g) => a + (g.max ? (g.score / g.max) * 100 : 0), 0) / sGrades.length;
            const avgRnd = Math.round(avgNum);
            avgStr = `${avgRnd}%`;
            lgStr  = typeof letterGrade === 'function' ? letterGrade(avgRnd) : calcLg(avgRnd);
            
            avgCol = avgRnd >= 75 ? 'text-green-700 bg-green-50 border-green-200' 
                   : avgRnd >= 60 ? 'text-amber-700 bg-amber-50 border-amber-200' 
                   : 'text-red-700 bg-red-50 border-red-200';
        }

        // Show last 2 assessments (Clickable for editing)
        const recent = sGrades.sort((a,b) => new Date(b.date) - new Date(a.date)).slice(0, 2);
        const recentHtml = recent.length === 0 
            ? `<span class="text-[11px] text-[#9ab0c6] italic">No grades entered</span>`
            : recent.map(g => {
                const isOverride = g.enteredByAdmin || (g.historyLogs && g.historyLogs.length > 0);
                const p = g.max ? Math.round((g.score/g.max)*100) : 0;
                const pCol = p >= 75 ? '#0ea871' : p >= 60 ? '#f59e0b' : '#e31b4a';
                return `
                    <div onclick="window.openEditGradePanel('${s.id}', '${g.id}')" 
                        class="flex items-center gap-2 mb-1 last:mb-0 cursor-pointer hover:bg-slate-100 p-1.5 -ml-1.5 rounded transition group" 
                        title="Click to edit grade">
                        <span class="text-[10px] font-bold text-[#6b84a0] w-14 truncate group-hover:text-[#2563eb]">${escHtml(g.type)}</span>
                        <span class="text-[11px] font-black group-hover:underline" style="color:${pCol}">${g.score}/${g.max}</span>
                        ${isOverride ? `<i class="fa-solid fa-triangle-exclamation text-amber-500 text-[10px] ml-1" title="Admin Edited/Overridden"></i>` : ''}
                        <i class="fa-solid fa-pen text-[#c5d0db] text-[9px] opacity-0 group-hover:opacity-100 transition ml-1"></i>
                    </div>`;
            }).join('');

        return `
            <tr class="border-b border-[#f0f4f8] hover:bg-[#f8fafb] transition">
                <td class="px-6 py-4">
                    <div class="flex items-center gap-3">
                        <div class="h-9 w-9 bg-[#0d1f35] text-white rounded-lg flex items-center justify-center font-black text-sm flex-shrink-0">
                            ${escHtml(s.name || '?').charAt(0).toUpperCase()}
                        </div>
                        <div>
                            <p class="font-bold text-[#0d1f35] text-[13px] leading-tight">${escHtml(s.name)}</p>
                            <p class="text-[10px] font-mono text-[#9ab0c6] uppercase tracking-widest mt-0.5">${s.id}</p>
                        </div>
                    </div>
                </td>
                <td class="px-6 py-4 text-center">
                    <span class="text-[10px] font-bold bg-[#eef4ff] text-[#2563eb] border border-[#c7d9fd] px-2 py-0.5 rounded">${escHtml(s.className)}</span>
                </td>
                <td class="px-6 py-4 text-center">
                    <div class="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg border ${avgCol}">
                        <span class="font-black text-[13px]">${avgStr}</span>
                        <span class="text-[11px] font-bold opacity-70">${lgStr}</span>
                    </div>
                </td>
                <td class="px-6 py-4">
                    ${recentHtml}
                </td>
                <td class="px-6 py-4 text-right">
                    <button onclick="window.openGradePanel('${s.id}')"
                        class="bg-white hover:bg-amber-50 hover:border-amber-300 text-[#0d1f35] hover:text-[#b45309] font-bold px-3 py-1.5 rounded text-[11px] transition border border-[#dce3ed] shadow-sm flex items-center gap-1.5 ml-auto">
                        <i class="fa-solid fa-plus"></i> Override
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

// ── 7. PANEL LOGIC (ADD & EDIT) ───────────────────────────────────────────
window.openGradePanel = function(studentId) {
    const student = currentRoster.find(s => s.id === studentId);
    if (!student) return;

    window.targetStudent = student;
    window.editGradeMode = false;
    window.editGradeId = null;
    window.editGradeOldData = null;

    const subject = document.getElementById('filterSubject').value;

    document.getElementById('panelHeaderTitle').textContent = 'Admin Grade Override';
    document.getElementById('saveGradeText').textContent = 'Commit Admin Override';
    document.getElementById('panelStudentName').textContent = `${student.name} (${student.id})`;
    
    // Unlock Fields
    document.getElementById('agType').disabled = false;
    document.getElementById('agTitle').readOnly = false;

    // Reset Form
    document.getElementById('agSubject').value = subject;
    document.getElementById('agType').value = '';
    document.getElementById('agTitle').value = '';
    document.getElementById('agScore').value = '';
    document.getElementById('agMax').value = '100';
    document.getElementById('agDate').valueAsDate = new Date();
    document.getElementById('agNotes').value = '';
    document.getElementById('gradeMsg').classList.add('hidden');
    
    updatePreview();
    openOverlay('gradeEntryPanel', 'gradeEntryPanelInner', true);
};

window.openEditGradePanel = function(studentId, gradeId) {
    const student = currentRoster.find(s => s.id === studentId);
    const grade   = currentGrades.find(g => g.id === gradeId);
    if (!student || !grade) return;

    window.targetStudent = student;
    window.editGradeMode = true;
    window.editGradeId = gradeId;
    window.editGradeOldData = grade;

    document.getElementById('panelHeaderTitle').textContent = 'Edit Assessment Record';
    document.getElementById('saveGradeText').textContent = 'Update Grade Record';
    document.getElementById('panelStudentName').textContent = `${student.name} (${student.id})`;

    // Populate Fields
    document.getElementById('agSubject').value = grade.subject;
    document.getElementById('agType').value = grade.type;
    document.getElementById('agTitle').value = grade.title;
    document.getElementById('agScore').value = grade.score;
    document.getElementById('agMax').value = grade.max;
    document.getElementById('agDate').value = grade.date;
    document.getElementById('agNotes').value = ''; // Force new note
    document.getElementById('gradeMsg').classList.add('hidden');

    // Lock Fundamental Assignment Details
    document.getElementById('agType').disabled = true;
    document.getElementById('agTitle').readOnly = true;

    updatePreview();
    openOverlay('gradeEntryPanel', 'gradeEntryPanelInner', true);
};

window.closeGradePanel = () => closeOverlay('gradeEntryPanel', 'gradeEntryPanelInner', true);

function updatePreview() {
    const score = parseFloat(document.getElementById('agScore').value);
    const max   = parseFloat(document.getElementById('agMax').value);
    const prev  = document.getElementById('gradePreview');

    if (!isNaN(score) && !isNaN(max) && max > 0 && score >= 0) {
        const pct    = Math.round((score / max) * 100);
        const color  = pct >= 90 ? 'text-[#0ea871]' : pct >= 80 ? 'text-[#2563eb]' : pct >= 70 ? 'text-[#f59e0b]' : 'text-[#e31b4a]';
        const lbg    = pct >= 90 ? 'bg-[#edfaf4] border-[#c6f0db] text-[#0ea871]' : pct >= 80 ? 'bg-[#eef4ff] border-[#c7d9fd] text-[#2563eb]' : pct >= 70 ? 'bg-[#fffbeb] border-[#fef3c7] text-[#f59e0b]' : 'bg-[#fff0f3] border-[#ffd6de] text-[#e31b4a]';
        const lbl    = pct >= 90 ? 'Excelling' : pct >= 80 ? 'Good Standing' : pct >= 70 ? 'On Track' : 'Requires Attention';

        prev.classList.remove('hidden');
        document.getElementById('prevPct').textContent    = `${pct}%`;
        document.getElementById('prevPct').className      = `text-4xl font-black font-mono ${color}`;
        document.getElementById('prevLetter').textContent = typeof letterGrade === 'function' ? letterGrade(pct) : (pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 60 ? 'D' : 'F');
        document.getElementById('prevLetter').className   = `text-2xl font-black px-5 py-2 rounded-lg border ${lbg}`;
        document.getElementById('prevLabel').textContent  = lbl;
        document.getElementById('prevLabel').className    = `text-[11px] font-bold uppercase tracking-widest mt-3 ${color}`;
    } else {
        prev.classList.remove('hidden');
        document.getElementById('prevPct').textContent    = `—`;
        document.getElementById('prevPct').className      = `text-4xl font-black font-mono text-[#9ab0c6]`;
        document.getElementById('prevLetter').textContent = `—`;
        document.getElementById('prevLetter').className   = `text-2xl font-black px-5 py-2 rounded-lg border border-[#dce3ed] bg-white text-[#9ab0c6]`;
        document.getElementById('prevLabel').textContent  = `Awaiting Input`;
        document.getElementById('prevLabel').className    = `text-[11px] font-bold uppercase tracking-widest mt-3 text-[#9ab0c6]`;
    }
}

// ── 8. SAVE / UPDATE GRADE ────────────────────────────────────────────────
async function saveGrade() {
    if (!window.targetStudent) return;

    const subject = document.getElementById('agSubject').value;
    const type    = document.getElementById('agType').value;
    const title   = document.getElementById('agTitle').value.trim();
    const score   = parseFloat(document.getElementById('agScore').value);
    const max     = parseFloat(document.getElementById('agMax').value);
    const semId   = document.getElementById('filterSemester').value;
    const date    = document.getElementById('agDate').value;
    const notes   = document.getElementById('agNotes').value.trim();

    const msgEl = document.getElementById('gradeMsg');
    const showMsg = (text) => {
        msgEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-1"></i> ${text}`;
        msgEl.classList.remove('hidden');
    };

    if (!type || !title) return showMsg('Grade type and title are required.');
    if (isNaN(score) || isNaN(max) || max <= 0) return showMsg('Please enter valid score and max values.');
    if (score < 0 || score > max) return showMsg('Score cannot be negative or exceed the maximum.');
    if (!notes) return showMsg('An Admin Audit Note is mandatory for overriding or editing a grade.');

    msgEl.classList.add('hidden');

    const btn = document.getElementById('saveGradeBtn');
    const originalBtnHTML = btn.innerHTML;
    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Securing Record...';

    try {
        const adminDisplayName = session.isSuperAdmin ? (session.schoolName || 'Super Admin') : (session.adminName || 'Sub-Admin');
        const now = new Date().toISOString();

        if (window.editGradeMode && window.editGradeId) {
            // EDIT EXISTING GRADE LOGIC
            const oldData = window.editGradeOldData;
            
            const historyEntry = {
                dateChanged: now,
                adminId: session.adminId || session.schoolId,
                adminName: adminDisplayName,
                oldScore: oldData.score,
                oldMax: oldData.max,
                oldDate: oldData.date,
                newScore: score,
                newMax: max,
                note: notes
            };

            await updateDoc(doc(db, 'schools', session.schoolId, 'students', window.targetStudent.id, 'grades', window.editGradeId), {
                score,
                max,
                date,
                historyLogs: arrayUnion(historyEntry)
            });

            // Update local cache
            const gIdx = currentGrades.findIndex(g => g.id === window.editGradeId);
            if (gIdx > -1) {
                currentGrades[gIdx].score = score;
                currentGrades[gIdx].max = max;
                currentGrades[gIdx].date = date;
                if (!currentGrades[gIdx].historyLogs) currentGrades[gIdx].historyLogs = [];
                currentGrades[gIdx].historyLogs.push(historyEntry);
            }

        } else {
            // ADD NEW OVERRIDE LOGIC
            const gradeData = {
                teacherId:       window.targetStudent.teacherId || '', 
                semesterId:      semId,
                subject,
                type,
                date,
                title,
                score,
                max,
                notes:           `[Admin Override] ${notes}`,
                historyLogs:     [],
                createdAt:       now,

                // Audit fields
                enteredByAdmin:  true,
                adminId:         session.adminId || session.schoolId,
                adminName:       adminDisplayName,
                adminRole:       session.isSuperAdmin ? 'super_admin' : 'sub_admin'
            };

            const newDocRef = await addDoc(
                collection(db, 'schools', session.schoolId, 'students', window.targetStudent.id, 'grades'),
                gradeData
            );

            // Update local cache
            currentGrades.push({ id: newDocRef.id, studentId: window.targetStudent.id, ...gradeData });
        }

        renderGrid();
        window.closeGradePanel();

    } catch (e) {
        console.error('[AdminGradeEntry] saveGrade:', e);
        showMsg('System error. Could not secure record.');
        btn.disabled  = false;
        btn.innerHTML = originalBtnHTML;
    }
}
