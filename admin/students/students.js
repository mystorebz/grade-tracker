import { db } from '../../assets/js/firebase-init.js';
import { collection, doc, getDoc, getDocs, updateDoc, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { openOverlay, closeOverlay, showMsg, letterGrade } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');

// Inject layout: Page ID, Title, Subtitle, showSearch=true, showPeriod=false
injectAdminLayout('students', 'School Directory', 'All enrolled students and their academic records', true, false);

// ── 2. STATE & CONSTANTS ──────────────────────────────────────────────────
let allStudentsCache = [];
let allTeachersCache = [];
let currentStudentId = null;

const CLASSES = {
    'Primary': ['Infant 1', 'Infant 2', 'Standard 1', 'Standard 2', 'Standard 3', 'Standard 4', 'Standard 5', 'Standard 6'],
    'High School': ['First Form', 'Second Form', 'Third Form', 'Fourth Form'],
    'Junior College': ['Year 1', 'Year 2']
};

const tbody = document.getElementById('studentsTableBody');
const filterClassSelect = document.getElementById('filterStudentClass');
const filterTeacherSelect = document.getElementById('filterStudentTeacher');

// ── 3. LOAD STUDENTS & TEACHERS ───────────────────────────────────────────
async function loadStudents() {
    tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-slate-400 font-semibold"><i class="fa-solid fa-spinner fa-spin text-emerald-400 text-2xl mb-3 block"></i>Loading students...</td></tr>`;
    
    try {
        const [sSnap, tSnap] = await Promise.all([
            getDocs(query(collection(db, 'students'), where('schoolId', '==', session.schoolId))),
            getDocs(query(collection(db, 'teachers'), where('schoolId', '==', session.schoolId)))
        ]);
        
        const tm = {};
        allTeachersCache = [];
        tSnap.forEach(d => {
            tm[d.id] = d.data().name;
            if (!d.data().archived) allTeachersCache.push({ id: d.id, ...d.data() });
        });
        
        allStudentsCache = sSnap.docs
            .filter(d => !d.data().archived)
            .map(d => ({ id: d.id, ...d.data(), teacherName: tm[d.data().teacherId] || '—' }));
        
        // Populate Teacher Filter
        if (filterTeacherSelect.options.length <= 1) {
            filterTeacherSelect.innerHTML = '<option value="">All Teachers</option>' + 
                allTeachersCache.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
        }
        
        // Populate Class Filter based on School Type
        if (filterClassSelect.options.length <= 2) {
            const classList = CLASSES[session.schoolType || 'Primary'] || CLASSES['Primary'];
            filterClassSelect.innerHTML = '<option value="">All Classes</option><option value="unassigned">Unassigned Only</option>' + 
                classList.map(c => `<option value="${c}">${c}</option>`).join('');
        }

        renderTable();
    } catch (e) {
        console.error("Error loading students:", e);
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-red-500 font-semibold">Failed to load student data.</td></tr>`;
    }
}

// ── 4. RENDER & FILTER TABLE ──────────────────────────────────────────────
function renderTable() {
    let filtered = allStudentsCache;
    const filterT = filterTeacherSelect.value;
    const filterC = filterClassSelect.value;
    const searchInputEl = document.getElementById('searchInput');
    const term = searchInputEl ? searchInputEl.value.toLowerCase() : '';

    if (filterT) filtered = filtered.filter(s => s.teacherId === filterT);
    if (filterC === 'unassigned') filtered = filtered.filter(s => !s.className || !s.teacherId);
    else if (filterC) filtered = filtered.filter(s => s.className === filterC);

    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-slate-400 italic font-semibold">No students match the selected criteria.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(s => {
        const classBadge = s.className ? s.className : '<span class="bg-amber-100 text-amber-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider">Unassigned</span>';
        const teacherBadge = s.teacherName !== '—' ? s.teacherName : '<span class="bg-amber-100 text-amber-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider">Unassigned</span>';
        const displayStyle = (s.name || '').toLowerCase().includes(term) ? '' : 'display:none;';

        return `
        <tr class="trow border-b border-slate-100" style="${displayStyle}">
            <td class="px-6 py-4">
                <div class="flex items-center gap-3">
                    <div class="h-10 w-10 bg-gradient-to-br from-emerald-400 to-teal-500 text-white rounded-xl flex items-center justify-center font-black text-sm shadow-sm flex-shrink-0">${(s.name||'?').charAt(0).toUpperCase()}</div>
                    <span class="font-black text-slate-700">${s.name||'Unnamed'}</span>
                </div>
            </td>
            <td class="px-6 py-4 text-slate-600 font-semibold">${classBadge}</td>
            <td class="px-6 py-4 text-slate-600 font-semibold">${teacherBadge}</td>
            <td class="px-6 py-4 text-slate-600 font-semibold">${s.parentPhone||'—'}</td>
            <td class="px-6 py-4 text-right">
                <div class="flex items-center justify-end gap-2">
                    <button onclick="window.openArchiveReasonModal('${s.id}')" class="bg-amber-50 hover:bg-amber-500 hover:text-white text-amber-600 font-black px-3 py-1.5 rounded-lg text-xs transition border border-amber-200">Archive</button>
                    <button onclick="window.openReassignModal('${s.id}')" class="bg-blue-50 hover:bg-blue-600 hover:text-white text-blue-700 font-black px-3 py-1.5 rounded-lg text-xs transition border border-blue-200">Reassign</button>
                    <button onclick="window.openStudentPanel('${s.id}')" class="bg-emerald-50 hover:bg-emerald-600 hover:text-white text-emerald-700 font-black px-3 py-1.5 rounded-lg text-xs transition border border-emerald-200 hover:border-emerald-600">Records</button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

// ── 5. EVENT LISTENERS FOR FILTERS & SEARCH ───────────────────────────────
filterClassSelect.addEventListener('change', renderTable);
filterTeacherSelect.addEventListener('change', renderTable);

const searchInput = document.getElementById('searchInput');
if (searchInput) {
    searchInput.addEventListener('input', renderTable);
}

// ── 6. ARCHIVE STUDENT LOGIC ──────────────────────────────────────────────
window.openArchiveReasonModal = function(id) {
    currentStudentId = id;
    const s = allStudentsCache.find(x => x.id === id);
    document.getElementById('archiveStudentName').textContent = s ? s.name : 'this student';
    document.getElementById('archiveReasonSelect').value = 'Transferred to another school';
    document.getElementById('archiveReasonOther').value = '';
    document.getElementById('archiveReasonOther').classList.add('hidden');
    openOverlay('archiveReasonModal', 'archiveReasonModalInner');
};

window.closeArchiveReasonModal = function() {
    closeOverlay('archiveReasonModal', 'archiveReasonModalInner');
};

document.getElementById('archiveReasonSelect').addEventListener('change', function() {
    document.getElementById('archiveReasonOther').classList.toggle('hidden', this.value !== 'Other');
});

document.getElementById('confirmArchiveBtn').addEventListener('click', async () => {
    const sel = document.getElementById('archiveReasonSelect').value;
    const reason = sel === 'Other' ? document.getElementById('archiveReasonOther').value.trim() : sel;
    const btn = document.getElementById('confirmArchiveBtn');
    
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Archiving...';
    btn.disabled = true;
    
    try {
        await updateDoc(doc(db, 'students', currentStudentId), {
            archived: true,
            archivedAt: new Date().toISOString(),
            archiveReason: reason || 'Not specified',
            teacherId: '', // Unassign them on archive
            className: ''
        });
        
        closeArchiveReasonModal();
        window.closeStudentPanel(); // Close panel if open
        loadStudents(); // Reload table
    } catch(e) { 
        alert("Error archiving student."); 
        console.error(e);
    }
    
    btn.innerHTML = 'Confirm & Archive';
    btn.disabled = false;
});

// ── 7. REASSIGN STUDENT LOGIC ─────────────────────────────────────────────
window.openReassignModal = function(id) {
    currentStudentId = id;
    const s = allStudentsCache.find(x => x.id === id);
    
    document.getElementById('rsName').value = s.name || '';
    document.getElementById('reassignMsg').classList.add('hidden');

    const cSelect = document.getElementById('rsClass');
    const classList = CLASSES[session.schoolType || 'Primary'] || CLASSES['Primary'];
    cSelect.innerHTML = '<option value="">-- Unassigned --</option>' + 
        classList.map(c => `<option value="${c}" ${s.className===c?'selected':''}>${c}</option>`).join('');

    const tSelect = document.getElementById('rsTeacher');
    tSelect.innerHTML = '<option value="">-- Unassigned --</option>' + 
        allTeachersCache.map(t => `<option value="${t.id}" ${s.teacherId===t.id?'selected':''}>${t.name}</option>`).join('');

    openOverlay('reassignStudentModal', 'reassignStudentModalInner');
};

window.closeReassignModal = function() {
    closeOverlay('reassignStudentModal', 'reassignStudentModalInner');
};

document.getElementById('saveReassignBtn').addEventListener('click', async () => {
    const btn = document.getElementById('saveReassignBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`; 
    btn.disabled = true;

    try {
        const name = document.getElementById('rsName').value.trim();
        const className = document.getElementById('rsClass').value;
        const teacherId = document.getElementById('rsTeacher').value;

        await updateDoc(doc(db, 'students', currentStudentId), {
            name, className, teacherId
        });

        closeReassignModal();
        loadStudents(); 
    } catch(e) {
        showMsg('reassignMsg', 'Error updating student record.', true);
        console.error(e);
    }
    
    btn.innerHTML = `Save Changes`; 
    btn.disabled = false;
});

// ── 8. STUDENT RECORDS PANEL LOGIC ────────────────────────────────────────
window.openStudentPanel = async function(studentId) {
    currentStudentId = studentId; 
    const student = allStudentsCache.find(s => s.id === studentId);
    
    document.getElementById('sPanelName').textContent = student?.name || 'Student';
    document.getElementById('sPanelClass').textContent = student?.className || '—';
    
    const printBtn = document.getElementById('sPanelPrintBtn');
    if(printBtn) printBtn.onclick = () => window.printStudentRecord(studentId);

    document.getElementById('sPanelLoader').classList.remove('hidden');
    document.getElementById('subjectAccordions').classList.add('hidden');
    document.getElementById('subjectAccordions').innerHTML = '';
    
    openOverlay('studentPanel', 'studentPanelInner', true);
    
    try {
        const gradesSnap = await getDocs(collection(db, 'students', studentId, 'grades'));
        
        if (gradesSnap.empty) {
            document.getElementById('sPanelLoader').innerHTML = `<div class="text-center py-16"><div class="text-5xl mb-3">📂</div><p class="text-slate-400 font-semibold">No grades recorded yet.</p></div>`;
            return;
        }
        
        const by = {};
        gradesSnap.forEach(d => {
            const g = { id: d.id, ...d.data() };
            const subj = g.subject || 'Uncategorized';
            if (!by[subj]) by[subj] = [];
            by[subj].push(g);
        });
        
        const container = document.getElementById('subjectAccordions');
        container.innerHTML = Object.entries(by).map(([subject, grades]) => {
            const avg = grades.reduce((a, g) => a + (g.max ? g.score / g.max * 100 : 0), 0) / grades.length;
            const ac = avg >= 75 ? 'text-green-600' : avg >= 60 ? 'text-amber-600' : 'text-red-600';
            const ab = avg >= 75 ? 'bg-green-50 border-green-200' : avg >= 60 ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200';
            
            const rows = grades.map(g => {
                const pct = g.max ? Math.round(g.score / g.max * 100) : null;
                const c = pct == null ? 'text-slate-600' : pct >= 75 ? 'text-green-600' : pct >= 60 ? 'text-amber-600' : 'text-red-600';
                return `<div class="border border-slate-200 rounded-xl bg-white hover:shadow-sm transition"><div class="px-4 py-3 flex items-center justify-between"><div class="flex-1 min-w-0"><p class="font-bold text-slate-700 text-sm truncate">${g.title||'Assessment'}</p><p class="text-xs text-slate-400 font-semibold mt-0.5">${g.type||''} ${g.date?'· '+g.date:''}</p></div><div class="flex items-center gap-3 flex-shrink-0 ml-3"><span class="${c} font-black text-sm">${g.score}/${g.max||'?'}</span><button onclick="window.openAssignmentModal(${JSON.stringify(g).replace(/"/g,'&quot;')})" class="text-xs font-black text-blue-600 hover:bg-blue-600 hover:text-white border border-blue-200 px-3 py-1 rounded-lg transition">Detail</button></div></div></div>`;
            }).join('');
            
            return `<div class="rounded-2xl border border-slate-200 overflow-hidden shadow-sm"><div class="subject-header flex items-center justify-between px-5 py-4 bg-white cursor-pointer hover:bg-slate-50 transition" onclick="window.toggleSubjectAccordion(this)"><div class="flex items-center gap-3"><div class="w-9 h-9 bg-gradient-to-br from-blue-500 to-blue-600 text-white rounded-xl flex items-center justify-center font-black text-xs shadow-sm">${subject.charAt(0).toUpperCase()}</div><div><p class="font-black text-slate-800">${subject}</p><p class="text-xs text-slate-400 font-semibold">${grades.length} assignment${grades.length!==1?'s':''}</p></div></div><div class="flex items-center gap-3"><span class="badge ${ab} ${ac} border font-black">${avg.toFixed(0)}% avg</span><i class="fa-solid fa-chevron-down text-slate-400" style="transition:transform 0.2s"></i></div></div><div class="subject-body"><div class="px-4 pb-4 pt-2 bg-slate-50/70 space-y-2">${rows}</div></div></div>`;
        }).join('');
        
        document.getElementById('sPanelLoader').classList.add('hidden');
        container.classList.remove('hidden');
        
    } catch(e) {
        console.error(e);
        document.getElementById('sPanelLoader').innerHTML = `<p class="text-red-500 font-bold text-center py-10">Error loading records.</p>`;
    }
};

window.toggleSubjectAccordion = function(h) {
    const b = h.nextElementSibling;
    b.classList.toggle('open');
    h.querySelector('.fa-chevron-down').style.transform = b.classList.contains('open') ? 'rotate(180deg)' : 'rotate(0deg)';
};

window.closeStudentPanel = function() {
    closeOverlay('studentPanel', 'studentPanelInner', true);
    // Reset loader for next open
    document.getElementById('sPanelLoader').innerHTML = `<i class="fa-solid fa-circle-notch fa-spin text-4xl mb-3 text-emerald-500"></i><p class="font-semibold text-sm">Loading academic records...</p>`;
};

// ── 9. ASSIGNMENT DETAIL MODAL ────────────────────────────────────────────
window.openAssignmentModal = function(g) {
    const pct = g.max ? Math.round(g.score / g.max * 100) : null;
    const c = pct == null ? 'text-slate-600' : pct >= 75 ? 'text-green-600' : pct >= 60 ? 'text-amber-600' : 'text-red-600';
    const fill = pct == null ? '#94a3b8' : pct >= 75 ? '#22c55e' : pct >= 60 ? '#f59e0b' : '#ef4444';
    
    document.getElementById('aModalTitle').textContent = g.title || 'Assessment';
    const logs = (g.historyLogs || []).map(l => typeof l === 'object' ? `[${l.changedAt}] ${l.oldScore}/${l.oldMax} → ${l.newScore}/${l.newMax}. Reason: ${l.reason}` : l);
    
    document.getElementById('aModalBody').innerHTML = `<div class="text-center mb-6"><div class="${c} text-5xl font-black">${g.score}<span class="text-2xl text-slate-400">/${g.max||'?'}</span></div>${pct!==null?`<div class="${c} text-lg font-black mt-1">${pct}% · ${letterGrade(pct)}</div>`:''}<div class="mt-3 h-3 bg-slate-100 rounded-full overflow-hidden"><div class="h-full rounded-full" style="width:${pct||0}%;background:${fill};transition:width 0.6s ease"></div></div></div>
    <div class="space-y-2 text-sm mb-4">${[['Subject', g.subject||'—'],['Type', g.type||'—'],['Date', g.date||'—']].map(([l, v]) => `<div class="flex justify-between py-2 border-b border-slate-100"><span class="text-slate-400 font-bold uppercase text-xs tracking-wider">${l}</span><span class="font-black text-slate-700">${v}</span></div>`).join('')}</div>
    ${g.notes?`<div class="mt-4 bg-blue-50 border border-blue-100 rounded-xl p-4"><p class="text-xs font-black text-blue-500 uppercase tracking-wider mb-1">Teacher Notes</p><p class="text-sm text-slate-700 font-semibold italic">${g.notes}</p></div>`:''}
    ${logs.length?`<div class="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-4"><p class="text-xs font-black text-amber-600 uppercase tracking-wider mb-2"><i class="fa-solid fa-clock-rotate-left mr-1"></i>Edit History (${logs.length})</p><div class="space-y-1 max-h-32 overflow-y-auto">${logs.map(l=>`<p class="text-xs text-amber-800 font-semibold bg-white rounded-lg p-2 border border-amber-100">• ${l}</p>`).join('')}</div></div>`:''}`;
    
    openOverlay('assignmentModal', 'assignmentModalInner');
};

window.closeAssignmentModal = function() {
    closeOverlay('assignmentModal', 'assignmentModalInner');
};

// ── 10. CSV & PRINT EXPORTS ───────────────────────────────────────────────
document.getElementById('exportCsvBtn').addEventListener('click', () => {
    // Helper to generate CSV download from array of arrays
    const rows = [['Name', 'Class', 'Teacher', 'Parent Phone'], ...allStudentsCache.map(s => [s.name || '', s.className || '', s.teacherName || '', s.parentPhone || ''])];
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `${session.schoolId}_students.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
});

document.getElementById('printListBtn').addEventListener('click', () => {
    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>Students</title><style>body{font-family:sans-serif;padding:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #e2e8f0;padding:8px 12px;font-size:13px;text-align:left}th{background:#f8fafc;font-weight:700}</style></head><body><h2>${session.schoolName} — Student Directory</h2><p style="color:#64748b;font-size:12px;margin-bottom:16px">Printed ${new Date().toLocaleDateString()}</p><table><thead><tr><th>Name</th><th>Class</th><th>Teacher</th><th>Parent Phone</th></tr></thead><tbody>${allStudentsCache.map(s => `<tr><td>${s.name || ''}</td><td>${s.className || ''}</td><td>${s.teacherName || ''}</td><td>${s.parentPhone || '—'}</td></tr>`).join('')}</tbody></table></body></html>`);
    w.document.close();
    w.print();
});

// Professional Print Record logic extracted from monolith
window.printStudentRecord = async function(studentId) {
    const sDoc = await getDoc(doc(db, 'students', studentId));
    if (!sDoc.exists()) { alert("Student not found."); return; }
    const s = sDoc.data();
    
    // Fetch all grades
    const gradesSnap = await getDocs(collection(db, 'students', studentId, 'grades'));
    const grades = [];
    gradesSnap.forEach(d => grades.push(d.data()));

    // Organize by semester -> subject. Since semesters aren't fully loaded here, we group by ID and try to get names if needed, 
    // or just group by subject directly if semester data isn't globally available.
    // For simplicity, we fallback to "Unknown Period" as in the original if the map isn't available.
    const bySem = {};
    grades.forEach(g => {
        const sem = g.semesterId || 'Unknown Period';
        const sub = g.subject || 'Uncategorized';
        if (!bySem[sem]) bySem[sem] = {};
        if (!bySem[sem][sub]) bySem[sem][sub] = [];
        bySem[sem][sub].push(g);
    });

    let html = `<html><head><title>Student Record - ${s.name}</title>
    <style>
        body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; color: #1e293b; line-height: 1.5; }
        .header { text-align: center; border-bottom: 2px solid #cbd5e1; padding-bottom: 20px; margin-bottom: 30px; }
        .header h1 { margin: 0 0 5px 0; font-size: 24px; color: #0f172a; text-transform: uppercase; letter-spacing: 1px; }
        .header h2 { margin: 0; font-size: 16px; color: #64748b; font-weight: normal; letter-spacing: 2px; }
        .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 40px; background: #f8fafc; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0; }
        .info-item label { display: block; font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: bold; letter-spacing: 1px; }
        .info-item span { font-size: 14px; font-weight: bold; color: #0f172a; }
        .sem-block { margin-bottom: 40px; page-break-inside: avoid; }
        .sem-title { font-size: 16px; font-weight: bold; background: #334155; color: white; padding: 8px 15px; margin: 0 0 15px 0; border-radius: 4px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 13px; }
        th, td { border: 1px solid #e2e8f0; padding: 10px 15px; text-align: left; }
        th { background: #f1f5f9; color: #475569; font-weight: bold; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
        .text-center { text-align: center; }
        .text-right { text-align: right; }
        .avg-row { background: #f8fafc; font-weight: bold; }
        .footer { margin-top: 50px; text-align: center; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 15px; }
    </style></head><body>

    <div class="header">
        <h1>${session.schoolName}</h1>
        <h2>OFFICIAL STUDENT RECORD</h2>
    </div>

    <div class="info-grid">
        <div class="info-item"><label>Student Name</label><span>${s.name}</span></div>
        <div class="info-item"><label>Current Status</label><span>${s.archived ? 'Archived / Transferred' : 'Active'}</span></div>
        <div class="info-item"><label>Last Known Class</label><span>${s.className || 'Unassigned'}</span></div>
        <div class="info-item"><label>Parent Phone</label><span>${s.parentPhone || 'N/A'}</span></div>
    </div>`;

    if (Object.keys(bySem).length === 0) {
        html += `<p style="text-align:center; color:#64748b; font-style:italic; padding: 40px;">No academic grades recorded for this student.</p>`;
    } else {
        for (let sem in bySem) {
            html += `<div class="sem-block"><h3 class="sem-title">Period ID: ${sem}</h3><table>
                <thead><tr><th>Subject</th><th class="text-center">Assignments</th><th class="text-center">Average (%)</th><th class="text-center">Letter Grade</th></tr></thead><tbody>`;
            
            let semTotalPct = 0; let semSubjCount = 0;
            for (let sub in bySem[sem]) {
                const sGrades = bySem[sem][sub];
                const avg = Math.round(sGrades.reduce((acc, g) => acc + (g.max ? (g.score / g.max) * 100 : 0), 0) / sGrades.length);
                semTotalPct += avg; semSubjCount++;
                html += `<tr><td>${sub}</td><td class="text-center">${sGrades.length}</td><td class="text-center">${avg}%</td><td class="text-center">${letterGrade(avg)}</td></tr>`;
            }
            const semAvg = Math.round(semTotalPct / semSubjCount);
            html += `<tr class="avg-row"><td colspan="2" class="text-right">PERIOD AVERAGE:</td><td class="text-center">${semAvg}%</td><td class="text-center">${letterGrade(semAvg)}</td></tr>`;
            html += `</tbody></table></div>`;
        }
    }

    html += `<div class="footer">Printed on ${new Date().toLocaleDateString()} via ConnectUs Platform<br>Record generated by Admin: ${session.schoolId}</div></body></html>`;
    
    const w = window.open('', '_blank'); w.document.write(html); w.document.close();
    setTimeout(() => w.print(), 500);
};

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadStudents);
