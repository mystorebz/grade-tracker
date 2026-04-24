import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, updateDoc, collection, query, where, getDocs, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';
import { openOverlay, closeOverlay, showMsg } from '../../assets/js/utils.js';

// ── 1. AUTHENTICATION & LAYOUT ──────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('settings', 'Settings', 'Security & configuration', false);
}

// ── 2. STATE VARIABLES ──────────────────────────────────────────────────────
let schoolType = 'Primary';
let editingSubjectId = null;

const CLASSES = {
    'Primary': ['Infant 1', 'Infant 2', 'Standard 1', 'Standard 2', 'Standard 3', 'Standard 4', 'Standard 5', 'Standard 6'],
    'High School': ['First Form', 'Second Form', 'Third Form', 'Fourth Form'],
    'Junior College': ['Year 1', 'Year 2']
};

const DEFAULT_GRADE_TYPES = ['Test', 'Quiz', 'Assignment', 'Homework', 'Project', 'Midterm Exam', 'Final Exam'];

function genId() { return 'sub_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5); }
function getClasses() { return session.teacherData.classes || [session.teacherData.className || '']; }
function getActiveSubjects() { return (session.teacherData.subjects || []).filter(s => !s.archived); }
function getGradeTypes() { return session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES; }

// Escapes HTML to prevent XSS
function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    // Fetch School Data to know which class list to show
    try {
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolSnap.exists()) {
            schoolType = schoolSnap.data().schoolType || 'Primary';
        }
    } catch (e) { 
        console.error("[Settings] Error fetching school data", e); 
    }

    loadSettings();

    // Attach static event listeners
    document.getElementById('updateCodeBtn').addEventListener('click', updateLoginCode);
    document.getElementById('saveProfileBtn').addEventListener('click', saveProfile);
    document.getElementById('saveClassesBtn').addEventListener('click', saveClasses);
    document.getElementById('saveSubjectFormBtn').addEventListener('click', saveSubject);

    // Allow pressing "Enter" to add a grade type
    const gradeTypeInput = document.getElementById('newGradeTypeInput');
    if (gradeTypeInput) {
        gradeTypeInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                addGradeType();
            }
        });
    }
}

function loadSettings() {
    // 1. Profile & Security
    document.getElementById('profileName').value = session.teacherData.name || '';
    document.getElementById('profilePhone').value = session.teacherData.phone || '';
    toggleSecurityEdit(false);
    toggleProfileEdit(false);

    // 2. Classes
    const classes = getClasses().filter(Boolean);
    document.getElementById('currentClassesDisplay').textContent = classes.join(', ') || 'Not set';
    const classList = CLASSES[schoolType] || CLASSES['Primary'];
    
    // Fixed checkbox rendering to prevent double-toggling issues when clicking
    document.getElementById('settingsClassGrid').innerHTML = classList.map(c => {
        const safeId = c.replace(/\s/g, '_');
        const isChecked = classes.includes(c);
        return `
        <label class="flex items-center gap-3 p-3 border border-slate-200 rounded-xl cursor-pointer hover:bg-slate-50 transition ${isChecked ? 'bg-blue-50 border-blue-200 shadow-sm' : 'bg-white'}" id="swrap-${safeId}">
            <input type="checkbox" id="scb-${safeId}" value="${c}" ${isChecked ? 'checked' : ''} onchange="toggleClassVisuals('${safeId}')" class="w-5 h-5 text-blue-600 rounded border-slate-300 focus:ring-blue-500">
            <span class="font-bold text-slate-700 text-sm select-none">${c}</span>
        </label>`;
    }).join('');

    // 3. Lists
    renderGradeTypesList();
    renderSubjectsInSettings();
}

// ── 4. PROFILE & SECURITY ───────────────────────────────────────────────────
window.toggleSecurityEdit = function(isEditing) {
    ['currentTeacherCode', 'newTeacherCode', 'confirmTeacherCode'].forEach(id => {
        const el = document.getElementById(id);
        el.disabled = !isEditing;
        if (!isEditing) el.value = '';
        el.classList.toggle('bg-slate-50', !isEditing);
        el.classList.toggle('bg-white', isEditing);
    });
    document.getElementById('securityEditBtn').classList.toggle('hidden', isEditing);
    document.getElementById('securityActionBtns').classList.toggle('hidden', !isEditing);
    document.getElementById('settingsSecurityMsg').classList.add('hidden');
};

window.toggleProfileEdit = function(isEditing) {
    ['profileName', 'profilePhone'].forEach(id => {
        const el = document.getElementById(id);
        el.disabled = !isEditing;
        el.classList.toggle('bg-slate-50', !isEditing);
        el.classList.toggle('bg-white', isEditing);
    });
    
    if (!isEditing) {
        document.getElementById('profileName').value = session.teacherData.name || '';
        document.getElementById('profilePhone').value = session.teacherData.phone || '';
    }
    document.getElementById('profileEditBtn').classList.toggle('hidden', isEditing);
    document.getElementById('profileActionBtns').classList.toggle('hidden', !isEditing);
    document.getElementById('settingsProfileMsg').classList.add('hidden');
};

async function updateLoginCode() {
    const cur = document.getElementById('currentTeacherCode').value.trim();
    const nw = document.getElementById('newTeacherCode').value.trim();
    const cf = document.getElementById('confirmTeacherCode').value.trim();
    const mid = 'settingsSecurityMsg';
    
    if (!cur || !nw || !cf) { showMsg(mid, 'All three fields are required.', true); return; }
    if (cur !== session.teacherData.loginCode) { showMsg(mid, 'Current login code is incorrect.', true); return; }
    if (nw !== cf) { showMsg(mid, 'New codes do not match.', true); return; }
    if (nw.length < 5) { showMsg(mid, 'Minimum 5 characters required.', true); return; }
    
    const btn = document.getElementById('updateCodeBtn');
    const originalText = btn.textContent;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving...`;
    btn.disabled = true;
    
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { loginCode: nw });
        session.teacherData.loginCode = nw;
        
        // Update session storage so it persists
        sessionStorage.setItem('connectus_teacher_session', JSON.stringify(session));
        
        toggleSecurityEdit(false);
        showMsg(mid, 'Login code updated successfully!', false);
    } catch (e) {
        console.error('[Settings] Error saving code:', e);
        showMsg(mid, 'Error saving new code. Please try again.', true);
    }
    btn.innerHTML = originalText;
    btn.disabled = false;
}

async function saveProfile() {
    const u = {
        name: document.getElementById('profileName').value.trim(),
        phone: document.getElementById('profilePhone').value.trim()
    };
    
    if (!u.name) { showMsg('settingsProfileMsg', 'Full name is required.', true); return; }

    const btn = document.getElementById('saveProfileBtn');
    const originalText = btn.textContent;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving...`;
    btn.disabled = true;
    
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), u);
        
        Object.assign(session.teacherData, u);
        sessionStorage.setItem('connectus_teacher_session', JSON.stringify(session));
        
        // Update Sidebar visually
        const sbName = document.getElementById('displayTeacherName');
        const sbAvatar = document.getElementById('teacherAvatar');
        if (sbName) sbName.textContent = u.name;
        if (sbAvatar) sbAvatar.textContent = u.name.charAt(0).toUpperCase();
        
        toggleProfileEdit(false);
        showMsg('settingsProfileMsg', 'Profile saved successfully!', false);
    } catch (e) {
        console.error('[Settings] Error saving profile:', e);
        showMsg('settingsProfileMsg', 'Error saving profile. Please try again.', true);
    }
    btn.innerHTML = originalText;
    btn.disabled = false;
}

// ── 5. CLASSES ──────────────────────────────────────────────────────────────
window.toggleClassVisuals = function(safeId) {
    const cb = document.getElementById('scb-' + safeId);
    const wrap = document.getElementById('swrap-' + safeId);
    if (cb.checked) {
        wrap.classList.add('bg-blue-50', 'border-blue-200', 'shadow-sm');
        wrap.classList.remove('bg-white');
    } else {
        wrap.classList.remove('bg-blue-50', 'border-blue-200', 'shadow-sm');
        wrap.classList.add('bg-white');
    }
};

async function saveClasses() {
    const checkboxes = document.querySelectorAll('#settingsClassGrid input[type=checkbox]:checked');
    const selected = Array.from(checkboxes).map(c => c.value);
    
    if (!selected.length) { showMsg('settingsClassMsg', 'Please select at least one class.', true); return; }
    
    const btn = document.getElementById('saveClassesBtn');
    const originalText = btn.textContent;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i> Updating...`;
    btn.disabled = true;
    
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { 
            classes: selected, 
            className: selected[0] // Set primary class as the first selected
        });
        
        session.teacherData.classes = selected;
        session.teacherData.className = selected[0];
        sessionStorage.setItem('connectus_teacher_session', JSON.stringify(session));
        
        document.getElementById('currentClassesDisplay').textContent = selected.join(', ');
        
        // Update Sidebar Classes manually since we aren't reloading the page
        const sbClasses = document.getElementById('displayTeacherClasses');
        if (sbClasses) {
            sbClasses.innerHTML = selected.map(c => `<span class="class-pill">${escHtml(c)}</span>`).join('');
        }
        
        showMsg('settingsClassMsg', 'Classes updated successfully!', false);
    } catch (e) {
        console.error('[Settings] Error saving classes:', e);
        showMsg('settingsClassMsg', 'Error saving classes. Please try again.', true);
    }
    btn.innerHTML = originalText;
    btn.disabled = false;
}

// ── 6. GRADE TYPES ──────────────────────────────────────────────────────────
function renderGradeTypesList() {
    const types = getGradeTypes();
    document.getElementById('gradeTypesList').innerHTML = types.map(t => {
        const isDefault = DEFAULT_GRADE_TYPES.includes(t);
        return `
        <div class="flex items-center justify-between bg-white border border-slate-200 rounded-lg p-3 mb-2 shadow-sm transition hover:border-indigo-200">
            <span class="font-bold text-slate-700 text-sm">${escHtml(t)}</span>
            ${isDefault 
                ? `<span class="text-[10px] uppercase tracking-wider text-slate-400 font-black px-2 py-1 bg-slate-100 rounded-md">Default</span>` 
                : `<button onclick="deleteGradeType('${escHtml(t).replace(/'/g, "\\'")}')" class="text-slate-400 hover:text-red-500 hover:bg-red-50 p-1.5 rounded transition" title="Delete Type"><i class="fa-solid fa-trash-can text-sm"></i></button>`
            }
        </div>`;
    }).join('');
}

window.addGradeType = async function() {
    const input = document.getElementById('newGradeTypeInput');
    const nt = input.value.trim();
    if (!nt) return;
    
    let types = getGradeTypes();
    // Case-insensitive check for duplicates
    if (types.map(t => t.toLowerCase()).includes(nt.toLowerCase())) {
        showMsg('gradeTypeMsg', 'This grade type already exists.', true);
        return;
    }
    
    // UI Feedback
    const btn = input.nextElementSibling;
    const originalIcon = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
    btn.disabled = true;

    types.push(nt);
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { customGradeTypes: types });
        session.teacherData.customGradeTypes = types;
        sessionStorage.setItem('connectus_teacher_session', JSON.stringify(session));
        
        input.value = '';
        renderGradeTypesList();
        showMsg('gradeTypeMsg', 'New grade type added!', false);
    } catch (e) {
        console.error('[Settings] Error adding grade type:', e);
        showMsg('gradeTypeMsg', 'Error adding grade type. Please try again.', true);
        // Revert local array on failure
        types.pop(); 
    }
    btn.innerHTML = originalIcon;
    btn.disabled = false;
};

window.deleteGradeType = async function(type) {
    if (!confirm(`Are you sure you want to delete the "${type}" assignment category?`)) return;
    
    let types = getGradeTypes().filter(t => t !== type);
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { customGradeTypes: types });
        session.teacherData.customGradeTypes = types;
        sessionStorage.setItem('connectus_teacher_session', JSON.stringify(session));
        renderGradeTypesList();
    } catch (e) {
        console.error('[Settings] Error deleting grade type:', e);
        showMsg('gradeTypeMsg', 'Error deleting type. Please try again.', true);
    }
};

// ── 7. SUBJECTS MANAGEMENT ──────────────────────────────────────────────────
function renderSubjectsInSettings() {
    const active = getActiveSubjects();
    const container = document.getElementById('activeSubjectsList');
    
    if (!active.length) {
        container.innerHTML = '<div class="col-span-1 md:col-span-2 text-center py-10 bg-slate-50 rounded-2xl border border-dashed border-slate-200"><div class="w-12 h-12 bg-slate-100 text-slate-300 rounded-full flex items-center justify-center mx-auto mb-3 text-xl"><i class="fa-solid fa-book-open"></i></div><p class="text-sm font-bold text-slate-500">No active subjects</p><p class="text-xs text-slate-400 mt-1">Add your first subject to start building your curriculum.</p></div>';
        return;
    }
    
    container.innerHTML = active.map(s => `
        <div class="bg-white border border-slate-200 hover:border-teal-300 rounded-xl p-4 shadow-sm hover:shadow-md transition flex flex-col group">
            <div class="w-full flex justify-between items-start mb-2">
                <div class="flex-1 min-w-0 pr-2">
                    <p class="font-black text-slate-800 text-base truncate">${escHtml(s.name)}</p>
                </div>
                <div class="flex items-center gap-1.5 flex-shrink-0 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
                    <button onclick="openSubjectFormModal('${s.id}')" class="h-8 w-8 bg-white border border-teal-200 text-teal-600 hover:bg-teal-500 hover:text-white rounded-lg flex items-center justify-center transition shadow-sm" title="Edit Subject"><i class="fa-solid fa-pen text-xs"></i></button>
                    <button onclick="archiveSubject('${s.id}')" class="h-8 w-8 bg-white border border-amber-200 text-amber-600 hover:bg-amber-500 hover:text-white rounded-lg flex items-center justify-center transition shadow-sm" title="Archive Subject"><i class="fa-solid fa-box-archive text-xs"></i></button>
                </div>
            </div>
            ${s.description ? `<p class="text-xs text-slate-500 font-medium leading-relaxed line-clamp-2">${escHtml(s.description)}</p>` : `<p class="text-xs text-slate-300 italic">No description provided</p>`}
        </div>`).join('');
}

window.openSubjectFormModal = function(subjectId = null) {
    editingSubjectId = subjectId;
    const isEdit = subjectId !== null;
    
    document.getElementById('subjectFormTitle').textContent = isEdit ? 'Edit Subject' : 'Add Subject';
    document.getElementById('subjectFormIcon').className = isEdit ? 'fa-solid fa-pen text-lg' : 'fa-solid fa-layer-group text-lg';
    document.getElementById('saveSubjectFormBtn').textContent = isEdit ? 'Save Changes' : 'Create Subject';
    
    if (isEdit) {
        const sub = (session.teacherData.subjects || []).find(s => s.id === subjectId);
        document.getElementById('subjectFormName').value = sub?.name || '';
        document.getElementById('subjectFormDesc').value = sub?.description || '';
    } else {
        document.getElementById('subjectFormName').value = '';
        document.getElementById('subjectFormDesc').value = '';
    }
    
    document.getElementById('subjectFormMsg').classList.add('hidden');
    openOverlay('subjectFormModal', 'subjectFormModalInner');
};

window.closeSubjectFormModal = function() { 
    closeOverlay('subjectFormModal', 'subjectFormModalInner'); 
};

async function saveSubject() {
    const name = document.getElementById('subjectFormName').value.trim();
    const desc = document.getElementById('subjectFormDesc').value.trim();
    
    if (!name) { showMsg('subjectFormMsg', 'Subject name is required.', true); return; }
    
    const btn = document.getElementById('saveSubjectFormBtn');
    const originalText = btn.textContent;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving...`;
    btn.disabled = true;
    
    try {
        let newSubs = [...(session.teacherData.subjects || [])];
        
        if (editingSubjectId) {
            const oldSub = newSubs.find(s => s.id === editingSubjectId);
            const oldName = oldSub?.name || '';
            newSubs = newSubs.map(s => s.id === editingSubjectId ? { ...s, name, description: desc } : s);
            
            // If the name changed, we need to batch update all existing grades for all students so history doesn't break
            if (oldName && oldName !== name) {
                // Fetch all students belonging to this teacher
                const stuQuery = query(collection(db, 'schools', session.schoolId, 'students'), where('teacherId', '==', session.teacherId));
                const stuSnap = await getDocs(stuQuery);
                const students = stuSnap.docs.map(d => d.id);
                
                const batch = writeBatch(db);
                let batchCount = 0;
                
                for (const sid of students) {
                    const q = query(collection(db, 'schools', session.schoolId, 'students', sid, 'grades'), where('subject', '==', oldName));
                    const gSnap = await getDocs(q);
                    gSnap.forEach(d => {
                        batch.update(d.ref, { subject: name });
                        batchCount++;
                    });
                    // Firestore limit is 500 per batch. Commit and reset if getting close.
                    if (batchCount >= 490) { 
                        await batch.commit(); 
                        batchCount = 0; 
                    }
                }
                if (batchCount > 0) await batch.commit();
            }
        } else {
            // New Subject: check for duplicates
            if (newSubs.some(s => s.name.toLowerCase() === name.toLowerCase() && !s.archived)) {
                showMsg('subjectFormMsg', 'An active subject with this name already exists.', true);
                btn.innerHTML = originalText; 
                btn.disabled = false;
                return;
            }
            newSubs.push({ id: genId(), name, description: desc, archived: false, archivedAt: null });
        }
        
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { subjects: newSubs });
        session.teacherData.subjects = newSubs;
        sessionStorage.setItem('connectus_teacher_session', JSON.stringify(session));
        
        closeSubjectFormModal();
        renderSubjectsInSettings();
    } catch (e) {
        console.error('[Settings] Error saving subject:', e);
        showMsg('subjectFormMsg', 'Error saving subject. Please try again.', true);
    }
    btn.innerHTML = originalText;
    btn.disabled = false;
}

window.archiveSubject = async function(subjectId) {
    const sub = (session.teacherData.subjects || []).find(s => s.id === subjectId);
    if (!sub) return;
    if (!confirm(`Are you sure you want to archive "${sub.name}"?\n\nExisting student grades under this subject will remain safe, but it will be moved to your Archives and removed from active dropdowns.`)) return;
    
    try {
        const newSubs = session.teacherData.subjects.map(s => s.id === subjectId ? { ...s, archived: true, archivedAt: new Date().toISOString() } : s);
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { subjects: newSubs });
        
        session.teacherData.subjects = newSubs;
        sessionStorage.setItem('connectus_teacher_session', JSON.stringify(session));
        renderSubjectsInSettings();
    } catch (e) {
        console.error('[Settings] Error archiving subject:', e);
        alert('Failed to archive subject. Please check your connection and try again.');
    }
};

// Fire initialization
init();
