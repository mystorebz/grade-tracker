import { db } from '../../assets/js/firebase-init.js';
import { collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteField } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectAdminLayout } from '../../assets/js/layout-admin.js'; 
import { openOverlay, closeOverlay } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('admin', '../login.html');

injectAdminLayout('semesters', 'Grading Periods', 'Manage active and historical grading periods', false, false);

// ── 2. STATE & ELEMENTS ───────────────────────────────────────────────────
let allSemesters = [];
let currentEditSemId = null;
let currentMidtermSemId = null; // tracks which term the midterm modal is for

const activeListEl    = document.getElementById('activePeriodList');
const inactiveListEl  = document.getElementById('inactiveSemestersList');
const archivedListEl  = document.getElementById('archivedSemestersList');

// ── PERIOD LIFECYCLE HELPERS ───────────────────────────────────────────────
// A period has "passed" once its end date is before today. Passed periods are
// frozen: their dates can't be edited and they can't be (re)activated — so an
// old term can't be quietly rewritten and brought back. This is automatic.
function hasPeriodPassed(sem) {
    if (!sem || !sem.endDate) return false;
    const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today = startOfDay(new Date());
    const end   = startOfDay(new Date(sem.endDate + 'T00:00:00'));
    return end < today;
}

// Human-readable "end date has passed" string for the banner.
function formatEndDate(sem) {
    if (!sem || !sem.endDate) return '';
    try {
        return new Date(sem.endDate + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    } catch (e) { return sem.endDate; }
}

// Term label with the year appended (from the start date) so a new school
// year's "Term 1" is distinguishable from last year's — e.g. "Term 1 · 2026".
function termLabel(sem) {
    const name = sem?.name || 'Untitled';
    if (sem?.startDate) {
        const y = new Date(sem.startDate + 'T00:00:00').getFullYear();
        if (!Number.isNaN(y)) return `${name} · ${y}`;
    }
    return name;
}

// ── Accordion UI ──────────────────────────────────────────────────────────
document.getElementById('toggleAddPeriodBtn').addEventListener('click', () => {
    document.getElementById('addPeriodForm').classList.toggle('hidden');
    document.getElementById('addPeriodIcon').classList.toggle('rotate-180');
});

// ── Help Modal ────────────────────────────────────────────────────────────
document.getElementById('termHelpBtn').addEventListener('click', (e) => {
    e.preventDefault();
    openOverlay('helpSemModal', 'helpSemModalInner');
});
window.closeHelpSemModal = function() {
    closeOverlay('helpSemModal', 'helpSemModalInner');
};

// ── Dropdown & Auto-Populate Dates ────────────────────────────────────────
document.getElementById('presetSemName').addEventListener('change', (e) => {
    const val         = e.target.value;
    const customInput = document.getElementById('customSemName');
    const startInput  = document.getElementById('newSemStart');
    const endInput    = document.getElementById('newSemEnd');
    const hintEl      = document.getElementById('dateHint');
    
    const currentYear = new Date().getFullYear();

    if (val === 'custom') {
        customInput.classList.remove('hidden');
        customInput.focus();
        hintEl.textContent = '';
        startInput.value   = '';
        endInput.value     = '';
    } else {
        customInput.classList.add('hidden');
        customInput.value  = '';

        if (val === 'Term 1') {
            startInput.value = `${currentYear}-09-01`; 
            endInput.value   = `${currentYear}-11-30`;
            hintEl.textContent = "💡 Belize Term 1 typically runs from early September to late November.";
        } else if (val === 'Term 2') {
            const year       = new Date().getMonth() > 6 ? currentYear + 1 : currentYear; 
            startInput.value = `${year}-01-08`; 
            endInput.value   = `${year}-03-31`;
            hintEl.textContent = "💡 Belize Term 2 typically runs from early January to late March.";
        } else if (val === 'Term 3') {
            const year       = new Date().getMonth() > 6 ? currentYear + 1 : currentYear;
            startInput.value = `${year}-04-15`; 
            endInput.value   = `${year}-06-30`;
            hintEl.textContent = "💡 Belize Term 3 typically runs from mid-April to late June.";
        } else {
            hintEl.textContent = '';
            startInput.value   = '';
            endInput.value     = '';
        }
    }
});

// ── 3. LOAD SEMESTERS ─────────────────────────────────────────────────────
async function loadSemesters() {
    try {
        const sRef = collection(db, 'schools', session.schoolId, 'semesters');
        const snap = await getDocs(sRef);
        
        allSemesters = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.order - b.order);
        
        // Read the active semester id FRESH from the school document, not from the
        // cached session — a stale session made "Set Active" look like it did
        // nothing and desynced the locked/active display.
        let activeId = session.activeSemesterId || null;
        try {
            const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
            if (schoolSnap.exists()) {
                activeId = schoolSnap.data().activeSemesterId || null;
                if (session.activeSemesterId !== activeId) {
                    session.activeSemesterId = activeId;
                    try { setSessionData('admin', session); } catch (e) {}
                }
            }
        } catch (e) {
            console.error('Error reading active semester from school doc:', e);
        }
        
        const activePeriod    = allSemesters.find(s => s.id === activeId);
        const inactivePeriods = allSemesters.filter(s => !s.archived && s.id !== activeId);
        const archivedPeriods = allSemesters.filter(s => s.archived);

        // ── Render ACTIVE Period ───────────────────────────────────────────
        if (!activePeriod) {
            activeListEl.innerHTML = `
                <div class="bg-amber-50/50 border border-amber-200 rounded-xl p-4 text-center">
                    <p class="text-sm text-amber-700 font-bold"><i class="fa-solid fa-circle-exclamation mr-1"></i> No period is currently active.</p>
                </div>`;
        } else {
            const activePassed = hasPeriodPassed(activePeriod);
            activeListEl.innerHTML = `
                <div class="border ${activePassed ? 'border-amber-300' : 'border-green-300'} bg-green-50/20 rounded-2xl shadow-sm overflow-hidden">
                    <div class="flex items-center justify-between bg-white p-4 transition group">
                        <div>
                            <div class="flex items-center gap-3">
                                <i class="fa-solid fa-check text-green-500"></i>
                                <span class="font-black text-slate-800">${termLabel(activePeriod)}</span>
                                <span class="badge badge-active ml-2 bg-green-100 text-green-700 border-green-200">Active</span>
                                ${activePeriod.isLocked ? '<span class="bg-rose-100 text-rose-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider ml-1"><i class="fa-solid fa-lock mr-1"></i>Locked</span>' : ''}
                                ${activePassed ? '<span class="bg-amber-100 text-amber-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider ml-1"><i class="fa-solid fa-clock mr-1"></i>Ended</span>' : ''}
                            </div>
                            <p class="text-[10px] font-bold text-slate-500 mt-1 ml-7 uppercase tracking-wider">${activePeriod.startDate} TO ${activePeriod.endDate}</p>
                        </div>
                        <div class="flex items-center gap-2">
                            ${!activePeriod.midterm ? `
                                <button onclick="window.openMidtermModal('${activePeriod.id}')"
                                    class="text-xs font-black text-violet-600 hover:bg-violet-600 hover:text-white border border-violet-300 px-3 py-1.5 rounded-lg transition flex items-center gap-1.5"
                                    title="Add Midterm">
                                    <i class="fa-solid fa-plus text-[10px]"></i> Midterm
                                </button>` : ''}
                            <button onclick="window.toggleLockSem('${activePeriod.id}', ${!!activePeriod.isLocked})" class="text-slate-400 hover:text-indigo-600 transition h-8 w-8 flex items-center justify-center rounded-lg hover:bg-indigo-50" title="${activePeriod.isLocked ? 'Unlock Semester' : 'Lock Semester'}"><i class="fa-solid ${activePeriod.isLocked ? 'fa-lock text-rose-500' : 'fa-lock-open'}"></i></button>
                            ${activePassed
                                ? `<button onclick="window.explainFrozenPeriod()" class="text-slate-300 cursor-not-allowed h-8 w-8 flex items-center justify-center rounded-lg" title="This period has ended and can no longer be edited"><i class="fa-solid fa-lock"></i></button>`
                                : `<button onclick="window.openEditSemModal('${activePeriod.id}')" class="text-slate-400 hover:text-amber-500 transition h-8 w-8 flex items-center justify-center rounded-lg hover:bg-amber-50" title="Edit"><i class="fa-solid fa-pen"></i></button>`
                            }
                        </div>
                    </div>
                    ${activePeriod.midterm ? renderMidtermRow(activePeriod.id, activePeriod.midterm) : ''}
                    ${activePassed ? `
                    <div class="border-t border-amber-200 bg-amber-50 px-4 py-3">
                        <div class="flex items-start gap-2.5">
                            <i class="fa-solid fa-circle-exclamation text-amber-500 text-sm mt-0.5 flex-shrink-0"></i>
                            <div class="flex-1 min-w-0">
                                <p class="text-[12px] font-black text-amber-800">This grading period ended on ${formatEndDate(activePeriod)}.</p>
                                <p class="text-[11px] font-semibold text-amber-700 mt-0.5 leading-relaxed">When you're ready, lock it to freeze grades, archive it, or create and set a new grading period below. Its dates are now locked and can't be changed.</p>
                            </div>
                        </div>
                    </div>` : ''}
                </div>`;
        }

        // ── Render INACTIVE Periods ────────────────────────────────────────
        if (inactivePeriods.length === 0) {
            inactiveListEl.innerHTML = '<p class="text-sm text-slate-400 italic font-semibold">No inactive periods found.</p>';
        } else {
            inactiveListEl.innerHTML = inactivePeriods.map(s => {
                const passed = hasPeriodPassed(s);
                return `
                <div class="border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
                    <div class="flex items-center justify-between bg-white p-4 transition group hover:shadow-md">
                        <div>
                            <div class="flex items-center gap-3">
                                <i class="fa-solid fa-grip-lines text-slate-300"></i>
                                <span class="font-black text-slate-600">${termLabel(s)}</span>
                                ${s.isLocked ? '<span class="bg-rose-100 text-rose-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider ml-1"><i class="fa-solid fa-lock mr-1"></i>Locked</span>' : ''}
                                ${passed ? '<span class="bg-amber-100 text-amber-700 text-[10px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider ml-1"><i class="fa-solid fa-clock mr-1"></i>Ended</span>' : ''}
                            </div>
                            ${(s.startDate || s.endDate) ? `<p class="text-[10px] font-bold text-slate-400 mt-1 ml-6 uppercase tracking-wider">${s.startDate || '???'} TO ${s.endDate || '???'}</p>` : ''}
                        </div>
                        <div class="flex items-center gap-2">
                            ${!s.midterm && !passed ? `
                                <button onclick="window.openMidtermModal('${s.id}')"
                                    class="text-xs font-black text-violet-600 hover:bg-violet-600 hover:text-white border border-violet-300 px-3 py-1.5 rounded-lg transition opacity-0 group-hover:opacity-100 flex items-center gap-1.5"
                                    title="Add Midterm">
                                    <i class="fa-solid fa-plus text-[10px]"></i> Midterm
                                </button>` : ''}
                            ${passed
                                ? `<button onclick="window.explainFrozenPeriod()" class="text-xs font-black text-amber-600 border border-amber-200 bg-amber-50 px-3 py-1.5 rounded-lg cursor-not-allowed flex items-center gap-1.5" title="This period has ended and can't be reactivated"><i class="fa-solid fa-clock text-[10px]"></i> Ended</button>`
                                : (s.startDate && s.endDate
                                    ? `<button onclick="window.setActivePeriod('${s.id}')" class="text-xs font-black text-blue-600 hover:bg-blue-600 hover:text-white border border-blue-300 px-3 py-1.5 rounded-lg transition opacity-0 group-hover:opacity-100">Set Active</button>`
                                    : `<button onclick="alert('Please click the edit (pen) icon to set the Start and End dates before making this period active.')" class="text-xs font-black text-slate-400 border border-slate-200 hover:bg-slate-50 px-3 py-1.5 rounded-lg transition opacity-0 group-hover:opacity-100" title="Dates required">Needs Dates</button>`)
                            }
                            <button onclick="window.toggleLockSem('${s.id}', ${!!s.isLocked})" class="text-slate-400 hover:text-indigo-600 transition h-8 w-8 flex items-center justify-center rounded-lg hover:bg-indigo-50" title="${s.isLocked ? 'Unlock Semester' : 'Lock Semester'}"><i class="fa-solid ${s.isLocked ? 'fa-lock text-rose-500' : 'fa-lock-open'}"></i></button>
                            ${passed
                                ? `<button onclick="window.explainFrozenPeriod()" class="text-slate-300 cursor-not-allowed h-8 w-8 flex items-center justify-center rounded-lg" title="This period has ended and can no longer be edited"><i class="fa-solid fa-lock"></i></button>`
                                : `<button onclick="window.openEditSemModal('${s.id}')" class="text-slate-400 hover:text-amber-500 transition h-8 w-8 flex items-center justify-center rounded-lg hover:bg-amber-50" title="Edit"><i class="fa-solid fa-pen"></i></button>`
                            }
                            <button onclick="window.archiveSem('${s.id}')" class="text-slate-400 hover:text-red-500 transition h-8 w-8 flex items-center justify-center rounded-lg hover:bg-red-50" title="Archive"><i class="fa-solid fa-box-archive"></i></button>
                        </div>
                    </div>
                    ${s.midterm ? renderMidtermRow(s.id, s.midterm) : ''}
                </div>`;
            }).join('');
        }

        // ── Render ARCHIVED Periods ────────────────────────────────────────
        archivedListEl.innerHTML = archivedPeriods.length ? archivedPeriods.map(s => `
            <div class="flex items-center justify-between bg-slate-50 p-4 border border-slate-200 rounded-2xl shadow-sm">
                <div>
                    <div class="flex items-center gap-3"><i class="fa-solid fa-box-archive text-slate-300"></i><span class="font-black text-slate-500 line-through">${termLabel(s)}</span></div>
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

// ── MIDTERM ROW RENDERER ──────────────────────────────────────────────────
function renderMidtermRow(semId, midterm) {
    return `
        <div class="border-t border-violet-100 bg-violet-50/40 px-4 py-3 flex items-center justify-between">
            <div class="flex items-center gap-3">
                <i class="fa-solid fa-flag-checkered text-violet-400 text-[11px] ml-1"></i>
                <div>
                    <span class="text-[12px] font-black text-violet-700">${midterm.name || 'Midterm'}</span>
                    <span class="ml-2 text-[9px] font-black px-1.5 py-0.5 rounded bg-violet-100 text-violet-600 uppercase tracking-wider">Midterm</span>
                    ${(midterm.startDate && midterm.endDate) ? `<p class="text-[10px] font-bold text-violet-400 mt-0.5 uppercase tracking-wider">${midterm.startDate} TO ${midterm.endDate}</p>` : ''}
                </div>
            </div>
            <div class="flex items-center gap-2">
                <button onclick="window.openMidtermModal('${semId}')"
                    class="text-slate-400 hover:text-amber-500 transition h-8 w-8 flex items-center justify-center rounded-lg hover:bg-amber-50"
                    title="Edit Midterm">
                    <i class="fa-solid fa-pen text-[11px]"></i>
                </button>
                <button onclick="window.removeMidterm('${semId}')"
                    class="text-slate-400 hover:text-red-500 transition h-8 w-8 flex items-center justify-center rounded-lg hover:bg-red-50"
                    title="Remove Midterm">
                    <i class="fa-solid fa-trash text-[11px]"></i>
                </button>
            </div>
        </div>`;
}

// ── 4. GLOBAL ACTIVE PERIOD SETTER ────────────────────────────────────────
// Explains why a passed period can't be edited or reactivated (shown when the
// user clicks a frozen edit/activate control on an ended period).
window.explainFrozenPeriod = function() {
    alert("This grading period has already ended.\n\nIts dates are locked and it can no longer be edited or set active — this keeps past terms from being changed after the fact. To begin a new term, create a new grading period above.");
};

window.setActivePeriod = async function(id) {
    try {
        const sem = allSemesters.find(s => s.id === id);
        
        if (!sem || !sem.startDate || !sem.endDate) {
            alert("You must set a Start Date and End Date for this period before making it active.");
            return;
        }

        // Guard: a period whose end date has passed can't be (re)activated.
        if (hasPeriodPassed(sem)) {
            window.explainFrozenPeriod();
            return;
        }

        await updateDoc(doc(db, 'schools', session.schoolId), { activeSemesterId: id });
        
        session.activeSemesterId = id;
        setSessionData('admin', session);
        
        await loadSemesters();
    } catch (e) {
        console.error("Error setting active period:", e);
        alert("Failed to update active period.");
    }
};

// ── 5. ADD NEW PERIOD (unchanged) ─────────────────────────────────────────
document.getElementById('addSemBtn').addEventListener('click', async () => {
    const preset = document.getElementById('presetSemName').value;
    const custom = document.getElementById('customSemName').value.trim();
    const start  = document.getElementById('newSemStart').value;
    const end    = document.getElementById('newSemEnd').value;
    
    let finalName = preset === 'custom' ? custom : preset;
    
    if (!finalName)                              { alert("Please select or type a Period Name."); return; }
    if (!start || !end)                          { alert("Start and End dates are required."); return; }
    if (new Date(start) >= new Date(end))        { alert("End date must be after the Start date."); return; }
    
    const btn = document.getElementById('addSemBtn'); 
    btn.disabled  = true; 
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    
    try {
        await addDoc(collection(db, 'schools', session.schoolId, 'semesters'), {
            name:      finalName, 
            startDate: start, 
            endDate:   end, 
            order:     Date.now(), 
            archived:  false, 
            isLocked:  false
        });
        
        document.getElementById('presetSemName').value = ''; 
        document.getElementById('customSemName').value = '';
        document.getElementById('customSemName').classList.add('hidden');
        document.getElementById('newSemStart').value   = ''; 
        document.getElementById('newSemEnd').value     = '';
        document.getElementById('dateHint').textContent = '';
        
        document.getElementById('addPeriodForm').classList.add('hidden');
        document.getElementById('addPeriodIcon').classList.remove('rotate-180');
        
        loadSemesters();
    } catch (e) {
        console.error("Error adding period:", e);
        alert("Failed to add new period.");
    }
    
    btn.disabled  = false; 
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Create Period';
});

// ── 6. LOCK/UNLOCK (unchanged) ────────────────────────────────────────────
window.toggleLockSem = async function(id, currentLockStatus) {
    const newStatus = !currentLockStatus;
    const action    = newStatus ? "LOCK" : "UNLOCK";
    
    if (!confirm(`Are you sure you want to ${action} this grading period? \n\n${newStatus ? "Teachers will NOT be able to enter or edit grades for this period." : "Teachers will regain the ability to edit grades."}`)) return;
    
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'semesters', id), { isLocked: newStatus });
        loadSemesters();
    } catch (e) {
        console.error("Error locking/unlocking:", e);
        alert(`Failed to ${action.toLowerCase()} period.`);
    }
};

// ── 7. EDIT PERIOD MODAL (unchanged) ──────────────────────────────────────
window.openEditSemModal = function(id) {
    currentEditSemId = id;
    const sem = allSemesters.find(s => s.id === id);
    if (!sem) return;

    // Guard: passed periods are frozen — their dates can't be edited.
    if (hasPeriodPassed(sem)) {
        window.explainFrozenPeriod();
        return;
    }
    
    document.getElementById('editSemName').value  = sem.name      || '';
    document.getElementById('editSemStart').value = sem.startDate || '';
    document.getElementById('editSemEnd').value   = sem.endDate   || '';
    
    openOverlay('editSemModal', 'editSemModalInner');
};

window.closeEditSemModal = function() { 
    closeOverlay('editSemModal', 'editSemModalInner'); 
};

document.getElementById('saveSemEditBtn').addEventListener('click', async () => {
    const name      = document.getElementById('editSemName').value.trim();
    const startDate = document.getElementById('editSemStart').value;
    const endDate   = document.getElementById('editSemEnd').value;
    
    if (!name) { alert("Name is required"); return; }
    if (startDate && endDate && new Date(startDate) >= new Date(endDate)) { alert("End date must be after Start date."); return; }

    // Guard: never save edits to a period that has already passed.
    const editingSem = allSemesters.find(s => s.id === currentEditSemId);
    if (editingSem && hasPeriodPassed(editingSem)) {
        window.closeEditSemModal();
        window.explainFrozenPeriod();
        return;
    }
    
    const btn     = document.getElementById('saveSemEditBtn'); 
    btn.disabled  = true; 
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'semesters', currentEditSemId), { name, startDate, endDate });
        window.closeEditSemModal(); 
        loadSemesters();
    } catch (e) {
        console.error("Error editing period:", e);
        alert("Failed to save changes.");
    }
    
    btn.disabled  = false; 
    btn.innerHTML = 'Save Changes';
});

// ── 8. ARCHIVE / RESTORE (unchanged) ─────────────────────────────────────
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

// ── 9. MIDTERM MODAL ──────────────────────────────────────────────────────
window.openMidtermModal = function(semId) {
    currentMidtermSemId = semId;
    const sem = allSemesters.find(s => s.id === semId);
    if (!sem) return;

    // Set modal title and parent label
    document.getElementById('midtermModalTitle').textContent  = sem.midterm ? 'Edit Midterm' : 'Add Midterm';
    document.getElementById('midtermModalParent').textContent = `For: ${sem.name}`;

    // Pre-fill if editing existing midterm
    document.getElementById('midtermName').value  = sem.midterm?.name      || 'Midterm';
    document.getElementById('midtermStart').value = sem.midterm?.startDate || '';
    document.getElementById('midtermEnd').value   = sem.midterm?.endDate   || '';

    const msgEl = document.getElementById('midtermMsg');
    msgEl.textContent = '';
    msgEl.classList.add('hidden');

    openOverlay('midtermModal', 'midtermModalInner');
};

window.closeMidtermModal = function() {
    closeOverlay('midtermModal', 'midtermModalInner');
    currentMidtermSemId = null;
};

document.getElementById('saveMidtermBtn').addEventListener('click', async () => {
    const name      = document.getElementById('midtermName').value.trim();
    const startDate = document.getElementById('midtermStart').value;
    const endDate   = document.getElementById('midtermEnd').value;
    const msgEl     = document.getElementById('midtermMsg');

    msgEl.classList.add('hidden');

    if (!name)                                               { msgEl.textContent = 'Midterm name is required.';          msgEl.classList.remove('hidden'); return; }
    if (!startDate || !endDate)                              { msgEl.textContent = 'Start and End dates are required.';  msgEl.classList.remove('hidden'); return; }
    if (new Date(startDate) >= new Date(endDate))            { msgEl.textContent = 'End date must be after Start date.'; msgEl.classList.remove('hidden'); return; }

    // Validate midterm dates fall within the parent term
    const sem = allSemesters.find(s => s.id === currentMidtermSemId);
    if (sem && sem.startDate && sem.endDate) {
        if (new Date(startDate) < new Date(sem.startDate) || new Date(endDate) > new Date(sem.endDate)) {
            msgEl.textContent = `Midterm dates must fall within ${sem.name} (${sem.startDate} – ${sem.endDate}).`;
            msgEl.classList.remove('hidden');
            return;
        }
    }

    const btn     = document.getElementById('saveMidtermBtn');
    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Saving...';

    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'semesters', currentMidtermSemId), {
            midterm: { name, startDate, endDate }
        });

        window.closeMidtermModal();
        loadSemesters();
    } catch (e) {
        console.error("Error saving midterm:", e);
        msgEl.textContent = 'Failed to save midterm. Please try again.';
        msgEl.classList.remove('hidden');
    }

    btn.disabled  = false;
    btn.innerHTML = '<i class="fa-solid fa-flag-checkered"></i> Save Midterm';
});

// ── 10. REMOVE MIDTERM ────────────────────────────────────────────────────
window.removeMidterm = async function(semId) {
    if (!confirm("Remove the midterm from this period? This only removes the midterm date range — the grading period itself is not affected.")) return;

    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'semesters', semId), {
            midterm: deleteField()
        });
        loadSemesters();
    } catch (e) {
        console.error("Error removing midterm:", e);
        alert("Failed to remove midterm. Please try again.");
    }
};

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadSemesters);
