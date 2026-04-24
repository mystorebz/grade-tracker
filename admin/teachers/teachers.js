import { db } from '../../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, writeBatch, arrayUnion } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js';
import { openOverlay, closeOverlay, showMsg } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');

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

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Generates an official, permanent alphanumeric Teacher ID (e.g., T26-X9B2A)
function generateTeacherId() {
    const year = new Date().getFullYear().toString().slice(-2);
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let rand = '';
    for(let i = 0; i < 5; i++) {
        rand += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `T${year}-${rand}`;
}

// ── 3. LOAD TEACHERS (GLOBAL QUERY) ───────────────────────────────────────
async function loadTeachers() {
    tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center text-[#9ab0c6] font-semibold"><i class="fa-solid fa-spinner fa-spin text-[#2563eb] text-2xl mb-3 block"></i>Syncing with National Registry...</td></tr>`;
    
    try {
        // Query the GLOBAL teachers collection for anyone whose currentSchoolId matches this school
        const q = query(collection(db, 'teachers'), where('currentSchoolId', '==', session.schoolId));
        const tSnap = await getDocs(q);
        
        // We still query local students to count roster size
        const sSnap = await getDocs(collection(db, 'schools', session.schoolId, 'students'));
        const sc = {};
        sSnap.forEach(d => {
            const data = d.data();
            if (!data.archived && data.teacherId) {
                sc[data.teacherId] = (sc[data.teacherId] || 0) + 1;
            }
        });
        
        allTeachersCache = tSnap.docs.map(d => ({ id: d.id, ...d.data(), studentCount: sc[d.id] || 0 }));
            
        renderTable();
    } catch (e) {
        console.error("[Teachers] Error loading teachers:", e);
        tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center text-[#e31b4a] font-semibold">Database Connection Error.</td></tr>`;
    }
}

function renderTable() {
    const searchInputEl = document.getElementById('searchInput');
    const term = searchInputEl ? searchInputEl.value.toLowerCase() : '';
    
    const filtered = allTeachersCache.filter(t => t.name.toLowerCase().includes(term));

    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center text-[#9ab0c6] italic font-semibold">No active teachers mapped to this facility.</td></tr>`;
        return;
    }
    
    tbody.innerHTML = filtered.map(t => {
        const classes = getTeacherClasses(t);
        const subNames = getSubjectNames(t.subjects);
        
        return `<tr class="trow border-b border-[#f0f4f8] transition hover:bg-[#f8fafb]">
            <td class="px-6 py-4">
                <div class="flex items-center gap-3">
                    <div class="h-10 w-10 bg-[#0d1f35] text-white rounded flex items-center justify-center font-black text-sm flex-shrink-0">${escHtml(t.name).charAt(0).toUpperCase()}</div>
                    <div>
                        <p class="font-bold text-[#0d1f35] text-[13px] leading-tight">${escHtml(t.name)}</p>
                        <p class="text-[10.5px] font-mono text-[#6b84a0] uppercase tracking-widest mt-0.5">${escHtml(t.id)}</p>
                    </div>
                </div>
            </td>
            <td class="px-6 py-4">
                <div class="flex flex-wrap gap-1">${classes.length ? classes.map(c => `<span class="text-[10px] font-bold bg-[#eef4ff] text-[#2563eb] border border-[#c7d9fd] px-2 py-0.5 rounded">${escHtml(c)}</span>`).join('') : '<span class="text-[10px] text-[#9ab0c6] italic font-semibold">Unassigned</span>'}</div>
            </td>
            <td class="px-6 py-4 text-center"><span class="font-bold text-[13px] text-[#374f6b]">${t.studentCount}</span></td>
            <td class="px-6 py-4 text-center"><span class="font-bold text-[13px] text-[#374f6b]">${subNames.length || '0'}</span></td>
            <td class="px-6 py-4 text-center"><span class="font-mono font-black text-[13px] bg-[#f8fafb] border border-[#dce3ed] px-3 py-1.5 rounded tracking-widest text-[#0d1f35]">${escHtml(t.pin)}</span></td>
            <td class="px-6 py-4 text-right">
                <button onclick="window.openTeacherPanel('${t.id}')" class="bg-white hover:bg-[#eef4ff] text-[#2563eb] font-bold px-4 py-2 rounded text-[12px] transition border border-[#c7d9fd]">Manage</button>
            </td>
        </tr>`;
    }).join('');
}

const searchInput = document.getElementById('searchInput');
if (searchInput) searchInput.addEventListener('input', renderTable);


// ── 4. ADD / CLAIM TEACHER LOGIC ──────────────────────────────────────────
window.openAddTeacherModal = function() {
    ['tGlobalId', 'tName', 'tEmail', 'tPhone'].forEach(id => document.getElementById(id).value = '');
    openOverlay('addTeacherModal', 'addTeacherModalInner');
};

window.closeAddTeacherModal = function() {
    closeOverlay('addTeacherModal', 'addTeacherModalInner');
};

document.getElementById('saveTeacherBtn').addEventListener('click', async () => {
    const globalId = document.getElementById('tGlobalId').value.trim().toUpperCase();
    const name = document.getElementById('tName').value.trim();
    
    if (!globalId && !name) { 
        alert('You must provide a Name to create a new profile, or a Global ID to claim an existing one.'); 
        return; 
    }
    
    const btn = document.getElementById('saveTeacherBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i> Processing...`;
    btn.disabled = true;
    
    try {
        if (globalId) {
            // CLAIM EXISTING TEACHER (Transfer Workflow)
            const tRef = doc(db, 'teachers', globalId);
            const tSnap = await getDoc(tRef);
            
            if (!tSnap.exists()) {
                alert('No teacher found with that Global ID in the National Registry.');
                btn.innerHTML = 'Register to School'; btn.disabled = false;
                return;
            }
            
            const tData = tSnap.data();
            if (tData.currentSchoolId === session.schoolId) {
                alert('Teacher is already active at this facility.');
                window.closeAddTeacherModal();
                btn.innerHTML = 'Register to School'; btn.disabled = false;
                return;
            }
            
            // Push old school to archives, set new school to this one
            const updates = {
                currentSchoolId: session.schoolId
            };
            if (tData.currentSchoolId && tData.currentSchoolId !== "") {
                updates.archivedSchoolIds = arrayUnion(tData.currentSchoolId);
            }
            
            await updateDoc(tRef, updates);
            
        } else {
            // CREATE BRAND NEW GLOBAL PROFILE
            const newId = generateTeacherId();
            // Generate permanent 6-digit PIN
            const newPin = Math.floor(100000 + Math.random() * 900000).toString();
            
            await setDoc(doc(db, 'teachers', newId), {
                name,
                email: document.getElementById('tEmail').value.trim(),
                phone: document.getElementById('tPhone').value.trim(),
                pin: newPin,
                
                currentSchoolId: session.schoolId,
                archivedSchoolIds: [],
                
                subjects: [
                    { id: "sub_" + Date.now().toString(36) + "1", name: "Mathematics", archived: false, description: "" },
                    { id: "sub_" + Date.now().toString(36) + "2", name: "English Language Arts", archived: false, description: "" },
                    { id: "sub_" + Date.now().toString(36) + "3", name: "Science", archived: false, description: "" }
                ],
                classes: [],
                className: '',
                customGradeTypes: ["Test", "Quiz", "Assignment", "Homework", "Project", "Midterm Exam", "Final Exam"],
                archivedGradeTypes: [],
                createdAt: new Date().toISOString()
            });
        }
        
        window.closeAddTeacherModal();
        loadTeachers();
    } catch (e) {
        console.error('[Teachers] Error processing teacher:', e);
        alert('System Error. Please contact support.');
    }
    
    btn.innerHTML = 'Register to School';
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
        const snap = await getDoc(doc(db, 'teachers', teacherId));
        if (!snap.exists()) return;
        
        const t = { id: snap.id, ...snap.data() };
        
        const sSnap = await getDocs(collection(db, 'schools', session.schoolId, 'students'));
        const myStudents = sSnap.docs.map(d => d.data()).filter(d => d.teacherId === teacherId && !d.archived);
            
        const classes = getTeacherClasses(t);
        const subNames = getSubjectNames(t.subjects);
        
        document.getElementById('tPanelName').textContent = t.name;
        document.getElementById('tPanelClass').textContent = classes.length ? classes.join(' · ') : 'Class not yet assigned';
        
        document.getElementById('tInfoGrid').innerHTML = [
            ['National ID', t.id || '—'],
            ['Email', escHtml(t.email) || '—'],
            ['Phone', escHtml(t.phone) || '—'],
            ['Login PIN', escHtml(t.pin)]
        ].map(([l, v]) => `<div class="bg-white border border-[#dce3ed] rounded-lg p-3"><p class="text-[9px] font-bold text-[#6b84a0] uppercase tracking-widest mb-1">${l}</p><p class="font-bold text-[#0d1f35] text-[13px] ${l.includes('PIN') ? 'font-mono tracking-widest' : ''}">${v}</p></div>`).join('');
        
        document.getElementById('tClassTags').innerHTML = classes.length 
            ? classes.map(c => `<span class="bg-[#eef4ff] text-[#2563eb] border border-[#c7d9fd] font-bold text-[11px] px-3 py-1 rounded">${escHtml(c)}</span>`).join('') 
            : '<span class="text-[11px] text-[#9ab0c6] font-semibold italic">No classes assigned yet.</span>';
            
        document.getElementById('tSubjectTags').innerHTML = subNames.length 
            ? subNames.map(s => `<span class="bg-[#f8fafb] text-[#374f6b] border border-[#dce3ed] font-bold text-[11px] px-3 py-1 rounded">${escHtml(s)}</span>`).join('') 
            : '<span class="text-[11px] text-[#9ab0c6] font-semibold italic">No subjects recorded yet.</span>';
            
        // Populate Edit Fields
        document.getElementById('editTName').value = t.name || '';
        document.getElementById('editTEmail').value = t.email || '';
        document.getElementById('editTPhone').value = t.phone || '';
        
        document.getElementById('tPanelLoader').classList.add('hidden');
        document.getElementById('tViewMode').classList.remove('hidden');
    } catch (e) {
        console.error('[Teachers] Error opening panel:', e);
        document.getElementById('tPanelLoader').innerHTML = `<p class="text-[#e31b4a] font-bold text-center py-10">Error loading details.</p>`;
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
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving...`;
    btn.disabled = true;
    
    try {
        await updateDoc(doc(db, 'teachers', currentTeacherId), {
            name: document.getElementById('editTName').value.trim(),
            email: document.getElementById('editTEmail').value.trim(),
            phone: document.getElementById('editTPhone').value.trim()
        });
        
        window.editTeacherToggle(false);
        window.openTeacherPanel(currentTeacherId);
        loadTeachers();
    } catch (e) {
        console.error('[Teachers] Error editing teacher:', e);
        alert('Error saving changes.');
    }
    
    btn.innerHTML = 'Save Changes';
    btn.disabled = false;
});

// ── 6. THE EXIT GATEKEEPER (Atomic Batch Write) ───────────────────────────
window.openExitModal = function() {
    const tName = document.getElementById('tPanelName').textContent;
    document.getElementById('exitTeacherName').textContent = tName;
    
    document.getElementById('exitReason').value = '';
    document.getElementById('exitScore').value = '';
    document.getElementById('exitComments').value = '';
    
    openOverlay('exitModal', 'exitModalInner');
};

window.closeExitModal = function() {
    closeOverlay('exitModal', 'exitModalInner');
};

document.getElementById('confirmExitBtn').addEventListener('click', async () => {
    const reason = document.getElementById('exitReason').value;
    const score = document.getElementById('exitScore').value;
    const comments = document.getElementById('exitComments').value.trim();
    
    if (!reason || !score || !comments) {
        alert("All fields are mandatory to file an exit evaluation.");
        return;
    }
    
    const btn = document.getElementById('confirmExitBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i> Securing Record...`;
    btn.disabled = true;
    
    try {
        // Initialize an Atomic Batch Write
        const batch = writeBatch(db);
        
        // Command 1: Update the Global Teacher Document (Unassign them)
        const tRef = doc(db, 'teachers', currentTeacherId);
        batch.update(tRef, {
            currentSchoolId: "",
            archivedSchoolIds: arrayUnion(session.schoolId)
        });
        
        // Command 2: Create the Exit Evaluation inside the subcollection
        const evalRef = doc(collection(db, 'teachers', currentTeacherId, 'evaluations'));
        batch.set(evalRef, {
            evaluatorId: session.adminId || 'Admin',
            schoolId: session.schoolId,
            type: 'Exit Review',
            reason: reason,
            performanceScore: parseInt(score),
            comments: comments,
            timestamp: new Date().toISOString()
        });
        
        // Commit the batch
        await batch.commit();
        
        window.closeExitModal();
        window.closeTeacherPanel();
        loadTeachers();
        
    } catch (e) {
        console.error('[Teachers] Error during Exit Batch Write:', e);
        alert('System Database Error. Action aborted to protect record integrity.');
    }
    
    btn.innerHTML = `<i class="fa-solid fa-file-signature mr-2"></i> Submit Review & Archive Teacher`;
    btn.disabled = false;
});

// ── 7. EXPORTS ────────────────────────────────────────────────────────────
// Note: Kept basic for brevity, can be expanded exactly like your Roster export.

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadTeachers();
});
