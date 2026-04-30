import { db } from '../../assets/js/firebase-init.js';
import { collection, doc, getDoc, getDocs, updateDoc, addDoc, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { openOverlay, closeOverlay, showMsg, letterGrade } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');
injectAdminLayout('students', 'School Directory', 'All enrolled students and their academic records', true, false);

// ── 2. STATE ──────────────────────────────────────────────────────────────
let allStudentsCache = [];
let allTeachersCache = [];
let currentStudentId = null;
let currentStudentGradesCache = [];

const CLASSES = {
    'Primary': ['Infant 1', 'Infant 2', 'Standard 1', 'Standard 2', 'Standard 3', 'Standard 4', 'Standard 5', 'Standard 6'],
    'High School': ['First Form', 'Second Form', 'Third Form', 'Fourth Form'],
    'Junior College': ['Year 1', 'Year 2']
};

const tbody = document.getElementById('studentsTableBody');
const filterClassSelect = document.getElementById('filterStudentClass');
const filterTeacherSelect = document.getElementById('filterStudentTeacher');
const searchInput = document.getElementById('searchInput');

// ── 3. LOAD DIRECTORY ─────────────────────────────────────────────────────
async function loadStudents() {
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-slate-400 font-semibold"><i class="fa-solid fa-spinner fa-spin text-blue-500 text-2xl mb-3 block"></i>Loading directory...</td></tr>`;
    
    try {
        const [sSnap, tSnap] = await Promise.all([
            getDocs(query(collection(db, 'students'), where('currentSchoolId', '==', session.schoolId))),
            getDocs(query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId)))
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
        
        if (filterTeacherSelect && filterTeacherSelect.options.length <= 1) {
            filterTeacherSelect.innerHTML = '<option value="">All Teachers</option>' + 
                allTeachersCache.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
        }
        
        if (filterClassSelect && filterClassSelect.options.length <= 2) {
            const classList = CLASSES[session.schoolType || 'Primary'] || CLASSES['Primary'];
            filterClassSelect.innerHTML = '<option value="">All Classes</option><option value="unassigned">Unassigned Only</option>' + 
                classList.map(c => `<option value="${c}">${c}</option>`).join('');
        }

        renderTable();
    } catch (e) {
        console.error("Error loading students:", e);
        if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-red-500 font-semibold">Failed to load directory data.</td></tr>`;
    }
}

// ── 4. RENDER TABLE ───────────────────────────────────────────────────────
function renderTable() {
    if (!tbody) return;

    let filtered = allStudentsCache;
    const filterT = filterTeacherSelect?.value || '';
    const filterC = filterClassSelect?.value || '';
    const term = searchInput?.value.toLowerCase() || '';

    if (filterT) filtered = filtered.filter(s => s.teacherId === filterT);
    if (filterC === 'unassigned') filtered = filtered.filter(s => !s.className || !s.teacherId);
    else if (filterC) filtered = filtered.filter(s => s.className === filterC);

    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center text-slate-400 italic font-semibold">No students match the criteria.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(s => {
        const classBadge = s.className ? s.className : '<span class="bg-amber-100 text-amber-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase">Unassigned</span>';
        const displayStyle = (s.name || '').toLowerCase().includes(term) || s.id.toLowerCase().includes(term) ? '' : 'display:none;';

        return `
        <tr class="trow border-b border-slate-100 hover:bg-slate-50 transition" style="${displayStyle}">
            <td class="px-6 py-4">
                <div class="flex items-center gap-3">
                    <div class="h-10 w-10 bg-gradient-to-br from-blue-500 to-indigo-600 text-white rounded-xl flex items-center justify-center font-black text-sm shadow-sm flex-shrink-0">${(s.name||'?').charAt(0).toUpperCase()}</div>
                    <div>
                        <span class="font-black text-slate-700 block">${s.name||'Unnamed'}</span>
                        <span class="font-mono text-[10px] text-slate-400">${s.id}</span>
                    </div>
                </div>
            </td>
            <td class="px-6 py-4 text-slate-600 font-semibold">${classBadge}</td>
            <td class="px-6 py-4 text-slate-600 font-semibold">${s.teacherName}</td>
            <td class="px-6 py-4 text-slate-600 font-semibold">${s.parentPhone||'—'}</td>
            <td class="px-6 py-4 text-right">
                <button onclick="window.openStudentPanel('${s.id}')" class="bg-white hover:bg-blue-50 text-blue-600 font-bold px-4 py-2 rounded-lg text-xs transition border border-slate-200 hover:border-blue-200">
                    View Profile
                </button>
            </td>
        </tr>`;
    }).join('');
}

filterClassSelect?.addEventListener('change', renderTable);
filterTeacherSelect?.addEventListener('change', renderTable);
searchInput?.addEventListener('input', renderTable);

// ── 5. STUDENT PANEL & TABS ───────────────────────────────────────────────
window.switchStudentTab = function(tabId) {
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
    document.getElementById(`tab-${tabId}`)?.classList.remove('hidden');
    
    document.querySelectorAll('.panel-tab').forEach(btn => {
        if (btn.dataset.tab === tabId) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
};

window.toggleSEnrollDropdown = function() {
    document.getElementById('sEnrollDropdown')?.classList.toggle('hidden');
};

window.openStudentPanel = async function(studentId) {
    currentStudentId = studentId; 
    const student = allStudentsCache.find(s => s.id === studentId);
    
    document.getElementById('sPanelName').textContent = student?.name || 'Student';
    document.getElementById('sPanelId').textContent = student?.id || '—';
    document.getElementById('sEnrollDropdown')?.classList.add('hidden'); // Reset dropdown

    // Populate Overview Grid
    const infoGrid = document.getElementById('sInfoGrid');
    if (infoGrid) {
        infoGrid.innerHTML = [
            ['Name', student?.name || '—'],
            ['Date of Birth', student?.dob || '—'],
            ['Current Class', student?.className || 'Unassigned'],
            ['Assigned Teacher', student?.teacherName || 'Unassigned'],
            ['Parent/Guardian', student?.parentName || '—'],
            ['Parent Phone', student?.parentPhone || '—'],
            ['Parent Email', student?.email || '—'],
            ['Enrolled At', student?.createdAt ? new Date(student.createdAt).toLocaleDateString() : '—']
        ].map(([label, value]) => `
            <div class="flex justify-between items-center py-2 border-b border-slate-100 last:border-0">
                <span class="text-xs font-bold text-slate-400 uppercase tracking-wider">${label}</span>
                <span class="text-sm font-semibold text-slate-700">${value}</span>
            </div>
        `).join('');
    }

    // Populate Passport History Tab
    const historyContainer = document.getElementById('historyLogsContainer');
    if (historyContainer) {
        const history = student?.academicHistory || [];
        if (history.length > 0) {
            historyContainer.innerHTML = history.map(h => `
                <div class="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
                    <p class="font-bold text-slate-700">${h.schoolName || 'Unknown School'}</p>
                    <p class="text-xs text-slate-500 font-semibold mb-2">Departed: ${h.leftAt ? new Date(h.leftAt).toLocaleDateString() : 'Unknown Date'}</p>
                    <p class="text-sm text-slate-600 bg-slate-50 p-2 rounded border border-slate-100">Reason: ${h.reason || 'Not specified'}</p>
                </div>
            `).join('');
        } else {
            historyContainer.innerHTML = `<p class="text-center text-slate-400 font-semibold py-10 italic">No global transfer history for this student.</p>`;
        }
    }

    window.switchStudentTab('overview');
    document.getElementById('sPanelLoader')?.classList.remove('hidden');
    openOverlay('studentPanel', 'studentPanelInner', true);
    
    // Fetch Grades from global passport
    try {
        const gradesSnap = await getDocs(query(
            collection(db, 'students', studentId, 'grades'),
            where('schoolId', '==', session.schoolId)
        ));
        
        currentStudentGradesCache = [];
        gradesSnap.forEach(d => currentStudentGradesCache.push({ id: d.id, ...d.data() }));
        
        renderAdminGrades();
    } catch(e) {
        console.error(e);
    } finally {
        document.getElementById('sPanelLoader')?.classList.add('hidden');
    }
};

window.closeStudentPanel = function() {
    closeOverlay('studentPanel', 'studentPanelInner', true);
};

// ── 6. RENDER ADMIN GRADES (ACADEMIC TAB) ─────────────────────────────────
function renderAdminGrades() {
    const container = document.getElementById('subjectAccordions');
    if (!container) return;

    if (currentStudentGradesCache.length === 0) {
        container.innerHTML = `<div class="text-center py-16 bg-white rounded-xl border border-slate-200"><i class="fa-solid fa-folder-open text-4xl text-slate-300 mb-3"></i><p class="text-slate-400 font-semibold">No grades recorded yet.</p></div>`;
        return;
    }
    
    const bySubj = {};
    currentStudentGradesCache.forEach(g => {
        const subj = g.subject || 'Uncategorized';
        if (!bySubj[subj]) bySubj[subj] = [];
        bySubj[subj].push(g);
    });
    
    container.innerHTML = Object.entries(bySubj).map(([subject, grades]) => {
        // Standard average for admin view
        const avg = grades.reduce((a, g) => a + (g.max ? (g.score / g.max) * 100 : 0), 0) / grades.length;
        const avgR = Math.round(avg);
        const ac = avgR >= 75 ? 'text-green-700 bg-green-50 border-green-200' : avgR >= 60 ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-red-700 bg-red-50 border-red-200';
        
        const rows = grades.sort((a,b) => (b.date||'').localeCompare(a.date||'')).map(g => {
            const pct = g.max ? Math.round((g.score / g.max) * 100) : null;
            const c = pct == null ? 'text-slate-600' : pct >= 75 ? 'text-green-600' : pct >= 60 ? 'text-amber-600' : 'text-red-600';
            const adminTag = g.enteredByAdmin ? `<span class="ml-2 text-[9px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-black uppercase">Admin Entry</span>` : '';
            
            return `<div class="border border-slate-200 rounded-lg bg-white p-3 flex items-center justify-between">
                <div>
                    <p class="font-bold text-slate-700 text-sm">${g.title||'Assessment'} ${adminTag}</p>
                    <p class="text-xs text-slate-400 font-semibold mt-0.5">${g.type||''} · ${g.date||'No Date'}</p>
                </div>
                <div class="flex items-center gap-3">
                    <span class="font-mono text-sm font-bold text-slate-500">${g.score}/${g.max||'?'}</span>
                    <span class="${c} font-black text-sm bg-slate-50 px-2 py-1 rounded border border-slate-100">${pct!=null?pct+'%':'-'}</span>
                </div>
            </div>`;
        }).join('');
        
        return `<div class="rounded-xl border border-slate-200 overflow-hidden bg-white shadow-sm">
            <div class="flex items-center justify-between px-5 py-4 bg-slate-50 border-b border-slate-200">
                <div class="flex items-center gap-3">
                    <div class="w-8 h-8 bg-slate-800 text-white rounded flex items-center justify-center font-black text-xs">${subject.charAt(0)}</div>
                    <div>
                        <p class="font-black text-slate-800 text-sm">${subject}</p>
                        <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest">${grades.length} entries</p>
                    </div>
                </div>
                <div class="flex items-center gap-3">
                    <span class="${ac} border font-black text-xs px-2 py-1 rounded">${avgR}% Avg</span>
                </div>
            </div>
            <div class="p-3 bg-slate-100 space-y-2">${rows}</div>
        </div>`;
    }).join('');
}

// ── 7. ADMIN GRADE OVERRIDE LOGIC ─────────────────────────────────────────
window.openAdminAddGradeModal = function() {
    document.getElementById('agAddSubject').value = '';
    document.getElementById('agAddType').value = '';
    document.getElementById('agAddTitle').value = '';
    document.getElementById('agAddScore').value = '';
    document.getElementById('agAddMax').value = '100';
    document.getElementById('agAddDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('agAddNotes').value = '';
    
    openOverlay('adminAddGradeModal', 'adminAddGradeModalInner');
};

window.closeAdminAddGradeModal = function() {
    closeOverlay('adminAddGradeModal', 'adminAddGradeModalInner');
};

document.getElementById('saveAdminAddGradeBtn')?.addEventListener('click', async () => {
    const subj  = document.getElementById('agAddSubject').value.trim();
    const type  = document.getElementById('agAddType').value.trim();
    const title = document.getElementById('agAddTitle').value.trim();
    const score = document.getElementById('agAddScore').value;
    const max   = document.getElementById('agAddMax').value;
    const date  = document.getElementById('agAddDate').value;
    const notes = document.getElementById('agAddNotes').value.trim();

    if (!subj || !type || !title || score === '' || max === '' || !notes) {
        alert("All fields, including Admin Notes, are mandatory for an override.");
        return;
    }

    const btn = document.getElementById('saveAdminAddGradeBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Saving...';
    btn.disabled = true;

    try {
        const payload = {
            schoolId: session.schoolId, // Strict passport adherence
            subject: subj,
            type: type,
            title: title,
            score: parseFloat(score),
            max: parseFloat(max),
            date: date,
            notes: notes,
            enteredByAdmin: true,
            adminId: session.adminId || 'Admin',
            adminName: session.adminName || 'Admin User',
            createdAt: new Date().toISOString()
        };

        const docRef = await addDoc(collection(db, 'students', currentStudentId, 'grades'), payload);
        currentStudentGradesCache.push({ id: docRef.id, ...payload });
        
        renderAdminGrades();
        closeAdminAddGradeModal();
    } catch (e) {
        console.error("Error adding admin grade:", e);
        alert("Failed to save admin grade override.");
    }
    
    btn.innerHTML = 'Save Official Grade';
    btn.disabled = false;
});

// ── 8. ARCHIVE & REASSIGN (MOVED TO PANEL ACTIONS) ────────────────────────
window.openReassignModal = function() {
    document.getElementById('sEnrollDropdown')?.classList.add('hidden');
    const s = allStudentsCache.find(x => x.id === currentStudentId);
    if (!s) return;

    const cSelect = document.getElementById('rsClass');
    if (cSelect) {
        const classList = CLASSES[session.schoolType || 'Primary'] || CLASSES['Primary'];
        cSelect.innerHTML = '<option value="">-- Unassigned --</option>' + 
            classList.map(c => `<option value="${c}" ${s.className===c?'selected':''}>${c}</option>`).join('');
    }

    const tSelect = document.getElementById('rsTeacher');
    if (tSelect) {
        tSelect.innerHTML = '<option value="">-- Unassigned --</option>' + 
            allTeachersCache.map(t => `<option value="${t.id}" ${s.teacherId===t.id?'selected':''}>${t.name}</option>`).join('');
    }

    openOverlay('reassignStudentModal', 'reassignStudentModalInner');
};

window.closeReassignModal = function() { closeOverlay('reassignStudentModal', 'reassignStudentModalInner'); };

document.getElementById('saveReassignBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('saveReassignBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Saving...`; 
    btn.disabled = true;

    try {
        const className = document.getElementById('rsClass')?.value || '';
        const teacherId = document.getElementById('rsTeacher')?.value || '';
        
        await updateDoc(doc(db, 'students', currentStudentId), { className, teacherId });
        
        closeReassignModal();
        await loadStudents(); 
        
        // Update Panel UI instantly
        if (document.getElementById('sInfoGrid')) {
            const tm = allTeachersCache.find(t => t.id === teacherId);
            document.getElementById('sInfoGrid').innerHTML = document.getElementById('sInfoGrid').innerHTML
                .replace(/Current Class<\/span>\s*<span[^>]*>[^<]*<\/span>/, `Current Class</span> <span class="text-sm font-semibold text-slate-700">${className || 'Unassigned'}</span>`)
                .replace(/Assigned Teacher<\/span>\s*<span[^>]*>[^<]*<\/span>/, `Assigned Teacher</span> <span class="text-sm font-semibold text-slate-700">${tm ? tm.name : 'Unassigned'}</span>`);
        }
    } catch(e) {
        console.error(e);
        alert("Error reassigning student.");
    }
    
    btn.innerHTML = `Save Assignment`; 
    btn.disabled = false;
});

window.openArchiveReasonModal = function() {
    document.getElementById('sEnrollDropdown')?.classList.add('hidden');
    document.getElementById('archiveReasonSelect').value = 'Transferred to another school';
    document.getElementById('archiveReasonOther').classList.add('hidden');
    document.getElementById('archiveReasonOther').value = '';
    openOverlay('archiveReasonModal', 'archiveReasonModalInner');
};

window.closeArchiveReasonModal = function() { closeOverlay('archiveReasonModal', 'archiveReasonModalInner'); };

document.getElementById('archiveReasonSelect')?.addEventListener('change', function() {
    document.getElementById('archiveReasonOther')?.classList.toggle('hidden', this.value !== 'Other');
});

document.getElementById('confirmArchiveBtn')?.addEventListener('click', async () => {
    const sel = document.getElementById('archiveReasonSelect')?.value;
    const reason = sel === 'Other' ? document.getElementById('archiveReasonOther')?.value.trim() : sel;
    const btn = document.getElementById('confirmArchiveBtn');
    
    if (sel === 'Other' && !reason) {
        alert("Please specify the reason.");
        return;
    }
    
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Archiving...';
    btn.disabled = true;
    
    try {
        await updateDoc(doc(db, 'students', currentStudentId), {
            archived: true,
            archivedAt: new Date().toISOString(),
            archiveReason: reason || 'Not specified',
            teacherId: '', 
            className: ''
        });
        
        closeArchiveReasonModal();
        closeStudentPanel(); 
        loadStudents(); 
    } catch(e) { 
        console.error(e);
        alert("Error archiving student."); 
    }
    
    btn.innerHTML = 'Confirm & Archive';
    btn.disabled = false;
});

// Initialize
document.addEventListener('DOMContentLoaded', loadStudents);
