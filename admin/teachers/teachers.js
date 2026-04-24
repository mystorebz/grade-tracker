import { db } from '../../assets/js/firebase-init.js';
import { collection, doc, getDoc, getDocs, addDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { openOverlay, closeOverlay, showMsg } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');

// Inject layout: Page ID, Title, Subtitle, showSearch=true, showPeriod=false
injectAdminLayout('teachers', 'Teaching Staff', 'Manage active staff members and access codes', true, false);

// ── 2. STATE & HELPERS ────────────────────────────────────────────────────
let allTeachersCache = [];
let currentTeacherId = null;
let isEditMode = false;

const tbody = document.getElementById('teachersTableBody');

function getSubjectNames(subjects) {
    if (!subjects || !subjects.length) return [];
    if (typeof subjects[0] === 'string') return subjects;
    return subjects.filter(s => !s.archived).map(s => s.name);
}

function getTeacherClasses(t) {
    return t.classes || (t.className ? [t.className] : []);
}

// Generates the short 6-character login code (e.g., MT1234)
function generateTeacherCode(n) {
    const w = n.trim().split(/\s+/);
    const f = w[0]?.charAt(0).toUpperCase() || 'T';
    const l = w.length > 1 ? w[w.length - 1].charAt(0).toUpperCase() : (w[0]?.charAt(1).toUpperCase() || 'X');
    return `${f}${l}${Math.floor(1000 + Math.random() * 9000)}`;
}

// Generates an official, permanent alphanumeric Teacher ID (e.g., T26-4X9BA)
function generateTeacherId() {
    const year = new Date().getFullYear().toString().slice(-2);
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let rand = '';
    for(let i = 0; i < 5; i++) {
        rand += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `T${year}-${rand}`;
}

// ── 3. LOAD TEACHERS ──────────────────────────────────────────────────────
async function loadTeachers() {
    tbody.innerHTML = `<tr><td colspan="7" class="px-6 py-16 text-center text-slate-400 font-semibold"><i class="fa-solid fa-spinner fa-spin text-blue-400 text-2xl mb-3 block"></i>Loading staff...</td></tr>`;
    
    try {
        const [tSnap, sSnap] = await Promise.all([
            getDocs(collection(db, 'schools', session.schoolId, 'teachers')),
            getDocs(collection(db, 'schools', session.schoolId, 'students'))
        ]);
        
        // Count active students per teacher
        const sc = {};
        sSnap.forEach(d => {
            const data = d.data();
            if (!data.archived && data.teacherId) {
                sc[data.teacherId] = (sc[data.teacherId] || 0) + 1;
            }
        });
        
        allTeachersCache = tSnap.docs
            .filter(d => !d.data().archived)
            .map(d => ({ id: d.id, ...d.data(), studentCount: sc[d.id] || 0 }));
            
        renderTable();
    } catch (e) {
        console.error("Error loading teachers:", e);
        tbody.innerHTML = `<tr><td colspan="7" class="px-6 py-16 text-center text-red-500 font-semibold">Failed to load staff data.</td></tr>`;
    }
}

function renderTable() {
    const searchInputEl = document.getElementById('searchInput');
    const term = searchInputEl ? searchInputEl.value.toLowerCase() : '';
    
    // Filter locally based on search term
    const filtered = allTeachersCache.filter(t => t.name.toLowerCase().includes(term));

    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="px-6 py-16 text-center text-slate-400 italic font-semibold">No active teachers found.</td></tr>`;
        return;
    }
    
    tbody.innerHTML = filtered.map(t => {
        const classes = getTeacherClasses(t);
        const subNames = getSubjectNames(t.subjects);
        
        return `<tr class="trow border-b border-slate-100">
            <td class="px-6 py-4">
                <div class="flex items-center gap-3">
                    <div class="h-10 w-10 bg-gradient-to-br from-blue-500 to-blue-600 text-white rounded-xl flex items-center justify-center font-black text-sm shadow-sm flex-shrink-0">${t.name.charAt(0).toUpperCase()}</div>
                    <div><p class="font-black text-slate-700">${t.name}</p>${t.email ? `<p class="text-xs text-slate-400 font-semibold">${t.email}</p>` : ''}</div>
                </div>
            </td>
            <td class="px-6 py-4">
                <div class="flex flex-wrap gap-1">${classes.length ? classes.map(c => `<span class="text-[10px] font-black bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full">${c}</span>`).join('') : '<span class="bg-amber-100 text-amber-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider">Pending</span>'}</div>
            </td>
            <td class="px-6 py-4 text-center"><span class="bg-blue-50 text-blue-700 font-black text-sm px-3 py-1 rounded-lg border border-blue-200">${t.studentCount}</span></td>
            <td class="px-6 py-4 text-center"><span class="bg-slate-100 text-slate-600 font-bold text-xs px-3 py-1 rounded-lg border border-slate-200">${subNames.length || '—'}</span></td>
            <td class="px-6 py-4"><span class="font-mono font-black text-xs bg-slate-100 border border-slate-200 px-3 py-1.5 rounded-lg tracking-widest">${t.loginCode}</span></td>
            <td class="px-6 py-4"><span class="bg-green-100 text-green-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider">Active</span></td>
            <td class="px-6 py-4 text-right">
                <button onclick="window.openTeacherPanel('${t.id}')" class="bg-blue-50 hover:bg-blue-600 hover:text-white text-blue-700 font-black px-4 py-2 rounded-xl text-xs transition border border-blue-200 hover:border-blue-600">View</button>
            </td>
        </tr>`;
    }).join('');
}

// Search Listener
const searchInput = document.getElementById('searchInput');
if (searchInput) searchInput.addEventListener('input', renderTable);


// ── 4. ADD TEACHER LOGIC ──────────────────────────────────────────────────
window.openAddTeacherModal = function() {
    ['tName', 'tEmail', 'tPhone', 'tCode'].forEach(id => document.getElementById(id).value = '');
    openOverlay('addTeacherModal', 'addTeacherModalInner');
};

window.closeAddTeacherModal = function() {
    closeOverlay('addTeacherModal', 'addTeacherModalInner');
};

document.getElementById('saveTeacherBtn').addEventListener('click', async () => {
    const name = document.getElementById('tName').value.trim();
    if (!name) { alert('Name is required.'); return; }
    
    const btn = document.getElementById('saveTeacherBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;
    
    try {
        await addDoc(collection(db, 'schools', session.schoolId, 'teachers'), {
            name,
            email: document.getElementById('tEmail').value.trim(),
            phone: document.getElementById('tPhone').value.trim(),
            loginCode: document.getElementById('tCode').value.trim().toUpperCase() || generateTeacherCode(name),
            
            // The new permanent Teacher ID
            teacherIdNum: generateTeacherId(),

            subjects: [
                { id: "sub_" + Date.now().toString(36) + "1", name: "Mathematics", archived: false },
                { id: "sub_" + Date.now().toString(36) + "2", name: "English Language Arts", archived: false },
                { id: "sub_" + Date.now().toString(36) + "3", name: "Science", archived: false },
                { id: "sub_" + Date.now().toString(36) + "4", name: "Social Studies", archived: false }
            ],
            classes: [],
            className: '',
            customGradeTypes: [
                "Test",
                "Quiz",
                "Assignment",
                "Homework",
                "Project",
                "Midterm Exam",
                "Final Exam",
                "Independent Work"
            ],
            archived: false,
            archivedAt: null,
            requiresPinReset: true,
            createdAt: new Date().toISOString()
        });
        
        window.closeAddTeacherModal();
        loadTeachers();
    } catch (e) {
        console.error(e);
        alert('Error saving teacher.');
    }
    
    btn.innerHTML = 'Create Teacher Account';
    btn.disabled = false;
});


// ── 5. TEACHER PANEL (VIEW & EDIT) ────────────────────────────────────────
window.openTeacherPanel = async function(teacherId) {
    currentTeacherId = teacherId;
    window.editTeacherToggle(false);
    
    document.getElementById('tPanelLoader').classList.remove('hidden');
    document.getElementById('tViewMode').classList.add('hidden');
    document.getElementById('tEditMode').classList.add('hidden');
    
    openOverlay('teacherPanel', 'teacherPanelInner', true);
    
    try {
        const snap = await getDoc(doc(db, 'schools', session.schoolId, 'teachers', teacherId));
        if (!snap.exists()) return;
        
        const t = { id: snap.id, ...snap.data() };
        
        // Fetch students to see who belongs to this teacher
        const sSnap = await getDocs(collection(db, 'schools', session.schoolId, 'students'));
        const myStudents = sSnap.docs
            .map(d => d.data())
            .filter(d => d.teacherId === teacherId && !d.archived);
            
        const classes = getTeacherClasses(t);
        const subNames = getSubjectNames(t.subjects);
        
        // Populate UI
        document.getElementById('tPanelName').textContent = t.name;
        document.getElementById('tPanelClass').textContent = classes.length ? classes.join(' · ') : 'Class not yet assigned';
        
        document.getElementById('tInfoGrid').innerHTML = [
            ['Teacher ID', t.teacherIdNum || '—'],
            ['Email', t.email || '—'],
            ['Phone', t.phone || '—'],
            ['Login Code', t.loginCode],
            ['Students', myStudents.length + ' enrolled'],
            ['Member Since', t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '—'],
            ['Status', t.archived ? '<span class="bg-red-100 text-red-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider">Archived</span>' : '<span class="bg-green-100 text-green-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider">Active</span>']
        ].map(([l, v]) => `<div class="bg-slate-50 border border-slate-200 rounded-xl p-3"><p class="text-xs font-black text-slate-400 uppercase tracking-wider mb-1">${l}</p><p class="font-black text-slate-700 text-sm">${v}</p></div>`).join('');
        
        document.getElementById('tClassTags').innerHTML = classes.length 
            ? classes.map(c => `<span class="bg-blue-100 text-blue-700 border border-blue-200 font-bold text-xs px-3 py-1.5 rounded-full">${c}</span>`).join('') 
            : '<span class="text-sm text-slate-400 font-semibold italic">No classes assigned yet.</span>';
            
        document.getElementById('tSubjectTags').innerHTML = subNames.length 
            ? subNames.map(s => `<span class="bg-indigo-100 text-indigo-700 border border-indigo-200 font-bold text-xs px-3 py-1.5 rounded-full">${s}</span>`).join('') 
            : '<span class="text-sm text-slate-400 font-semibold italic">No subjects recorded yet.</span>';
            
        document.getElementById('tStudentsList').innerHTML = myStudents.length 
            ? myStudents.map(s => `<div class="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-xl p-3"><div class="h-8 w-8 bg-gradient-to-br from-emerald-400 to-teal-500 text-white rounded-lg flex items-center justify-center font-black text-xs flex-shrink-0">${(s.name || '?').charAt(0).toUpperCase()}</div><span class="font-bold text-slate-700 text-sm">${s.name || 'Unnamed'}</span><span class="text-xs text-slate-400 ml-auto">${s.className || ''}</span></div>`).join('') 
            : '<p class="text-sm text-slate-400 italic font-semibold">No students assigned yet.</p>';
            
        // Populate Edit Fields
        document.getElementById('editTName').value = t.name;
        document.getElementById('editTEmail').value = t.email || '';
        document.getElementById('editTPhone').value = t.phone || '';
        document.getElementById('editTCode').value = t.loginCode;
        
        document.getElementById('tPanelLoader').classList.add('hidden');
        document.getElementById('tViewMode').classList.remove('hidden');
    } catch (e) {
        console.error(e);
        document.getElementById('tPanelLoader').innerHTML = `<p class="text-red-500 font-bold text-center py-10">Error loading details.</p>`;
    }
};

window.closeTeacherPanel = function() {
    closeOverlay('teacherPanel', 'teacherPanelInner', true);
};

window.editTeacherToggle = function(show) {
    isEditMode = show !== undefined ? show : !isEditMode;
    document.getElementById('tViewMode').classList.toggle('hidden', isEditMode);
    document.getElementById('tEditMode').classList.toggle('hidden', !isEditMode);
    document.getElementById('editTeacherMsg').classList.add('hidden');
};

document.getElementById('saveTeacherEditBtn').addEventListener('click', async () => {
    const btn = document.getElementById('saveTeacherEditBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;
    
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', currentTeacherId), {
            name: document.getElementById('editTName').value.trim(),
            email: document.getElementById('editTEmail').value.trim(),
            phone: document.getElementById('editTPhone').value.trim(),
            loginCode: document.getElementById('editTCode').value.trim().toUpperCase()
        });
        showMsg('editTeacherMsg', 'Changes saved!', false, 'bg-green-50 text-green-700 border-green-200');
        window.editTeacherToggle(false);
        window.openTeacherPanel(currentTeacherId);
        loadTeachers();
    } catch (e) {
        console.error(e);
        showMsg('editTeacherMsg', 'Error updating.', true, 'bg-red-50 text-red-600 border-red-100');
    }
    
    btn.innerHTML = 'Save Changes';
    btn.disabled = false;
});

window.archiveCurrentTeacher = async function() {
    if (!confirm('Archive this teacher?')) return;
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', currentTeacherId), {
            archived: true,
            archivedAt: new Date().toISOString()
        });
        window.closeTeacherPanel();
        loadTeachers();
    } catch(e) {
        alert("Failed to archive teacher");
    }
};


// ── 6. CSV & PRINT EXPORTS ────────────────────────────────────────────────
document.getElementById('exportCsvBtn').addEventListener('click', () => {
    const rows = [['Teacher ID', 'Name', 'Email', 'Phone', 'Classes', 'Subjects', 'Login Code', 'Status'], 
        ...allTeachersCache.map(t => [
            t.teacherIdNum || '',
            t.name, 
            t.email || '', 
            t.phone || '', 
            getTeacherClasses(t).join('; '), 
            getSubjectNames(t.subjects).join('; '), 
            t.loginCode, 
            'Active'
        ])
    ];
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `${session.schoolId}_teachers.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
});

document.getElementById('printListBtn').addEventListener('click', () => {
    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>Staff</title><style>body{font-family:sans-serif;padding:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #e2e8f0;padding:8px 12px;font-size:13px;text-align:left}th{background:#f8fafc;font-weight:700}</style></head><body><h2>${session.schoolName} — Teaching Staff</h2><p style="color:#64748b;font-size:12px;margin-bottom:16px">Printed ${new Date().toLocaleDateString()}</p><table><thead><tr><th>Teacher ID</th><th>Name</th><th>Email</th><th>Classes</th><th>Login Code</th><th>Status</th></tr></thead><tbody>${allTeachersCache.map(t => `<tr><td>${t.teacherIdNum || '—'}</td><td>${t.name}</td><td>${t.email || '—'}</td><td>${getTeacherClasses(t).join(', ') || 'Pending'}</td><td>${t.loginCode}</td><td>Active</td></tr>`).join('')}</tbody></table></body></html>`);
    w.document.close();
    w.print();
});


// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadTeachers();
    
    // Check if URL parameters request opening the add modal automatically (from Dashboard)
    if (new URLSearchParams(window.location.search).get('action') === 'add') {
        window.openAddTeacherModal();
    }
});
