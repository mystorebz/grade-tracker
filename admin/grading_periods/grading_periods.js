import { db } from '../../assets/js/firebase-init.js';
import { collection, doc, getDocs, addDoc, updateDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js'; 
import { openOverlay, closeOverlay } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');

// Inject layout: Page ID 'semesters' matches the ID in layout-admin.js
injectAdminLayout('semesters', 'Grading Periods', 'Manage active and historical grading periods', false, false);

// ── 2. STATE & ELEMENTS ───────────────────────────────────────────────────
let allSemesters = [];
let currentEditSemId = null;

const activeListEl = document.getElementById('semestersList');
const archivedListEl = document.getElementById('archivedSemestersList');

// ── 3. LOAD SEMESTERS ─────────────────────────────────────────────────────
async function loadSemesters() {
    try {
        const sRef = collection(db, 'schools', session.schoolId, 'semesters');
        let snap = await getDocs(sRef);
        
        // Backwards compatibility / initial setup if empty
        if (snap.empty) {
            const defaultSems = [
                { id: 'sem1', name: 'Semester 1', startDate: '', endDate: '', order: 1, archived: false, isLocked: false },
                { id: 'sem2', name: 'Midterm', startDate: '', endDate: '', order: 2, archived: false, isLocked: false },
                { id: 'sem3', name: 'Semester 2', startDate: '', endDate: '', order: 3, archived: false, isLocked: false },
                { id: 'sem4', name: 'Semester 3', startDate: '', endDate: '', order: 4, archived: false, isLocked: false }
            ];
            await Promise.all(defaultSems.map(s => setDoc(doc(db, 'schools', session.schoolId, 'semesters', s.id), s)));
            snap = await getDocs(sRef);
        }
        
        allSemesters = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.order - b.order);
        
        // STRICT FIX: No automatic fallback. If it's not set in the session/DB, nothing is active.
        const activeId = session.activeSemesterId || null;

        const activePeriods = allSemesters.filter(s => !s.archived);
        const archivedPeriods = allSemesters.filter(s => s.archived);

        // Render Active List
        activeListEl.innerHTML = activePeriods.map(s => `
            <div class="flex items-center justify-between bg-white p-4 border rounded-2xl shadow-sm transition group hover:shadow-md ${s.id === activeId ? 'border-blue-300 bg-blue-50/40' : 'border-slate-200'}">
                <div>
                    <div class="flex items-center gap-3">
                        <i class="fa-solid fa-grip-lines text-slate-300"></i>
                        <span class="font-black text-slate-700">${s.name}</span>
                        ${s.id === activeId ? '<span class="badge badge-active ml-2">Active</span>' : ''}
                        ${s.isLocked ? '<span class="bg-rose-100 text-rose-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider ml-1"><i class="fa-solid fa-lock mr-1"></i>Locked</span>' : ''}
                    </div>
                    ${(s.startDate || s.endDate) ? `<p class="text-[10px] font-bold text-slate-400 mt-1 ml-6 uppercase tracking-wider">${s.startDate || '???'} TO ${s.endDate || '???'}</p>` : ''}
                </div>
                <div class="flex items-center gap-2">
                    ${s.id !== activeId ? 
                        (s.startDate && s.endDate ? 
                            `<button onclick="window.setActivePeriod('${s.id}')" class="text-xs font-black text-blue-600 hover:bg-blue-600 hover:text-white border border-blue-300 px-3 py-1.5 rounded-lg transition opacity-0 group-hover:opacity-100">Set Active</button>` 
                            : 
                            `<button onclick="alert('Please click the edit (pen) icon to set the Start and End dates before making this period active.')" class="text-xs font-black text-slate-400 border border-slate-200 hover:bg-slate-50 px-3 py-1.5 rounded-lg transition opacity-0 group-hover:opacity-100" title="Dates required">Needs Dates</button>`
                        ) 
                    : ''}
                    <button onclick="window.toggleLockSem('${s.id}', ${!!s.isLocked})" class="text-slate-400 hover:text-indigo-600 transition h-8 w-8 flex items-center justify-center rounded-lg hover:bg-indigo-50" title="${s.isLocked ? 'Unlock Semester' : 'Lock Semester'}"><i class="fa-solid ${s.isLocked ? 'fa-lock text-rose-500' : 'fa-lock-open'}"></i></button>
                    <button onclick="window.openEditSemModal('${s.id}')" class="text-slate-400 hover:text-amber-500 transition h-8 w-8 flex items-center justify-center rounded-lg hover:bg-amber-50" title="Edit"><i class="fa-solid fa-pen"></i></button>
                    <button onclick="window.archiveSem('${s.id}')" class="text-slate-400 hover:text-red-500 transition h-8 w-8 flex items-center justify-center rounded-lg hover:bg-red-50" title="Archive"><i class="fa-solid fa-box-archive"></i></button>
                </div>
            </div>`).join('');

        // Render Archived List
        archivedListEl.innerHTML = archivedPeriods.length ? archivedPeriods.map(s => `
            <div class="flex items-center justify-between bg-slate-50 p-4 border border-slate-200 rounded-2xl shadow-sm">
                <div>
                    <div class="flex items-center gap-3"><i class="fa-solid fa-box-archive text-slate-300"></i><span class="font-black text-slate-500 line-through">${s.name}</span></div>
                    ${(s.startDate || s.endDate) ? `<p class="text-[10px] font-bold text-slate-400 mt-1 ml-6 uppercase tracking-wider">${s.startDate || '???'} TO ${s.endDate || '???'}</p>` : ''}
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="window.restoreSem('${s.id}')" class="text-xs font-black text-green-700 hover:bg-green-600 hover:text-white border border-green-300 px-3 py-1.5 rounded-lg transition">Restore</button>
                </div>
            </div>`).join('') : '<p class="text-sm text-slate-400 italic font-semibold">No archived periods.</p>';

    } catch (e) {
        console.error("Error loading grading periods:", e);
        activeListEl.innerHTML = '<p class="text-red-500 font-bold">Error loading periods.</p>';
    }
}

// ── 4. GLOBAL ACTIVE PERIOD SETTER ────────────────────────────────────────
window.setActivePeriod = async function(id) {
    try {
        const sem = allSemesters.find(s => s.id === id);
        
        // Final logic guard: Block activation if dates are empty
        if (!sem || !sem.startDate || !sem.endDate) {
            alert("You must set a Start Date and End Date for this period before making it active.");
            return;
        }

        await updateDoc(doc(db, 'schools', session.schoolId), { activeSemesterId: id });
        
        // Update local session to instantly reflect the badge
        session.activeSemesterId = id;
        setSessionData('admin', session);
        
        loadSemesters();
    } catch (e) {
        console.error("Error setting active period:", e);
        alert("Failed to update active period.");
    }
};

// ── 5. ADD NEW PERIOD ─────────────────────────────────────────────────────
document.getElementById('addSemBtn').addEventListener('click', async () => {
    const n = document.getElementById('newSemName').value.trim();
    const start = document.getElementById('newSemStart').value;
    const end = document.getElementById('newSemEnd').value;
    
    if (!n) { alert("Period Name is required"); return; }
    
    const btn = document.getElementById('addSemBtn'); 
    btn.disabled = true; 
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    
    try {
        await addDoc(collection(db, 'schools', session.schoolId, 'semesters'), {
            name: n, 
            startDate: start, 
            endDate: end, 
            order: Date.now(), 
            archived: false, 
            isLocked: false
        });
        
        document.getElementById('newSemName').value = ''; 
        document.getElementById('newSemStart').value = ''; 
        document.getElementById('newSemEnd').value = '';
        
        loadSemesters();
    } catch (e) {
        console.error("Error adding period:", e);
        alert("Failed to add new period.");
    }
    
    btn.disabled = false; 
    btn.innerHTML = '<i class="fa-solid fa-plus"></i> Add Period';
});

// ── 6. LOCK/UNLOCK PERIOD ─────────────────────────────────────────────────
window.toggleLockSem = async function(id, currentLockStatus) {
    const newStatus = !currentLockStatus;
    const action = newStatus ? "LOCK" : "UNLOCK";
    
    if (!confirm(`Are you sure you want to ${action} this grading period? \n\n${newStatus ? "Teachers will NOT be able to enter or edit grades for this period." : "Teachers will regain the ability to edit grades."}`)) return;
    
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'semesters', id), { isLocked: newStatus });
        loadSemesters();
    } catch (e) {
        console.error("Error locking/unlocking:", e);
        alert(`Failed to ${action.toLowerCase()} period.`);
    }
};

// ── 7. EDIT PERIOD MODAL ──────────────────────────────────────────────────
window.openEditSemModal = function(id) {
    currentEditSemId = id;
    const sem = allSemesters.find(s => s.id === id);
    if (!sem) return;
    
    document.getElementById('editSemName').value = sem.name || '';
    document.getElementById('editSemStart').value = sem.startDate || '';
    document.getElementById('editSemEnd').value = sem.endDate || '';
    
    openOverlay('editSemModal', 'editSemModalInner');
};

window.closeEditSemModal = function() { 
    closeOverlay('editSemModal', 'editSemModalInner'); 
};

document.getElementById('saveSemEditBtn').addEventListener('click', async () => {
    const name = document.getElementById('editSemName').value.trim();
    const startDate = document.getElementById('editSemStart').value;
    const endDate = document.getElementById('editSemEnd').value;
    
    if (!name) return;
    
    const btn = document.getElementById('saveSemEditBtn'); 
    btn.disabled = true; 
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'semesters', currentEditSemId), { name, startDate, endDate });
        window.closeEditSemModal(); 
        loadSemesters();
    } catch (e) {
        console.error("Error editing period:", e);
        alert("Failed to save changes.");
    }
    
    btn.disabled = false; 
    btn.innerHTML = 'Save Changes';
});

// ── 8. ARCHIVE / RESTORE ──────────────────────────────────────────────────
window.archiveSem = async function(id) {
    if (id === session.activeSemesterId) {
        alert("This period is currently set as ACTIVE. You must set a different active period before archiving this one.");
        return;
    }
    
    if (!confirm("Archive this grading period? It will be removed from teachers' daily views but remain stored for historical reporting.")) return;
    
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'semesters', id), { archived: true });
        loadSemesters();
    } catch (e) {
        console.error("Error archiving period:", e);
    }
};

window.restoreSem = async function(id) {
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'semesters', id), { archived: false });
        loadSemesters();
    } catch (e) {
        console.error("Error restoring period:", e);
    }
};

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadSemesters);
