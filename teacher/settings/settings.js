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

// ── 3. INITIALIZATION ───────────────────────────────────────────────────────
async function init() {
    if (!session) return;

    // Fetch School Data to know which class list to show
    try {
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolSnap.exists()) {
            schoolType = schoolSnap.data().schoolType || 'Primary';
        }
    } catch (e) { console.error("Error fetching school data", e); }

    loadSettings();

    // Attach static event listeners
    document.getElementById('updateCodeBtn').addEventListener('click', updateLoginCode);
    document.getElementById('saveProfileBtn').addEventListener('click', saveProfile);
    document.getElementById('saveClassesBtn').addEventListener('click', saveClasses);
    document.getElementById('saveSubjectFormBtn').addEventListener('click', saveSubject);
}

function loadSettings() {
    // 1. Profile
    document.getElementById('profileName').value = session.teacherData.name || '';
    document.getElementById('profilePhone').value = session.teacherData.phone || '';
    toggleSecurityEdit(false);
    toggleProfileEdit(false);

    // 2. Classes
    const classes = getClasses().filter(Boolean);
    document.getElementById('currentClassesDisplay').textContent = classes.join(', ') || 'Not set';
    const classList = CLASSES[schoolType] || CLASSES['Primary'];
    
    document.getElementById('settingsClassGrid').innerHTML = classList.map(c => `
        <div class="cls-cb-item ${classes.includes(c) ? 'selected' : ''}" id="swrap-${c.replace(/\s/g, '_')}" onclick="toggleSettingsCb('${c.replace(/\s/g, '_')}', '${c}')">
            <input type="checkbox" id="scb-${c.replace(/\s/g, '_')}" value="${c}" ${classes.includes(c) ? 'checked' : ''}>
            <label for="scb-${c.replace(/\s/g, '_')}" onclick="event.stopPropagation()">${c}</label>
        </div>`).join('');

    // 3. Lists
    renderGradeTypesList();
    renderSubjectsInSettings();
}

// ── 4. PROFILE & SECURITY ───────────────────────────────────────────────────
window.toggleSecurityEdit = function(isEditing) {
    ['currentTeacherCode', 'newTeacherCode', 'confirmTeacherCode'].forEach(id => {
        document.getElementById(id).disabled = !isEditing;
        if (!isEditing) document.getElementById(id).value = '';
    });
    document.getElementById('securityEditBtn').classList.toggle('hidden', isEditing);
    document.getElementById('securityActionBtns').classList.toggle('hidden', !isEditing);
    document.getElementById('settingsSecurityMsg').classList.add('hidden');
};

window.toggleProfileEdit = function(isEditing) {
    ['profileName', 'profilePhone'].forEach(id => document.getElementById(id).disabled = !isEditing);
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
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;
    
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { loginCode: nw });
        session.teacherData.loginCode = nw;
        
        // Update session storage so it persists
        sessionStorage.setItem('connectus_teacher_session', JSON.stringify(session));
        
        toggleSecurityEdit(false);
        showMsg(mid, 'Login code updated!', false);
    } catch (e) {
        showMsg(mid, 'Error saving code.', true);
    }
    btn.innerHTML = 'Save Code';
    btn.disabled = false;
}

async function saveProfile() {
    const u = {
        name: document.getElementById('profileName').value.trim(),
        phone: document.getElementById('profilePhone').value.trim()
    };
    
    const btn = document.getElementById('saveProfileBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;
    
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), u);
        
        Object.assign(session.teacherData, u);
        sessionStorage.setItem('connectus_teacher_session', JSON.stringify(session));
        
        // Update Sidebar
        document.getElementById('displayTeacherName').textContent = u.name;
        document.getElementById('teacherAvatar').textContent = u.name.charAt(0).toUpperCase();
        
        toggleProfileEdit(false);
        showMsg('settingsProfileMsg', 'Profile saved!', false);
    } catch (e) {
        showMsg('settingsProfileMsg', 'Error saving profile.', true);
    }
    btn.innerHTML = 'Save Profile';
    btn.disabled = false;
}

// ── 5. CLASSES ──────────────────────────────────────────────────────────────
window.toggleSettingsCb = function(safeId, cls) {
    const cb = document.getElementById('scb-' + safeId);
    const wrap = document.getElementById('swrap-' + safeId);
    cb.checked = !cb.checked;
    wrap.classList.toggle('selected', cb.checked);
};

async function saveClasses() {
    const selected = [...document.querySelectorAll('#settingsClassGrid input[type=checkbox]:checked')].map(c => c.value);
    if (!selected.length) { showMsg('settingsClassMsg', 'Select at least one class.', true); return; }
    
    const btn = document.getElementById('saveClassesBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;
    
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { 
            classes: selected, 
            className: selected[0] 
        });
        
        session.teacherData.classes = selected;
        session.teacherData.className = selected[0];
        sessionStorage.setItem('connectus_teacher_session', JSON.stringify(session));
        
        document.getElementById('currentClassesDisplay').textContent = selected.join(', ');
        
        // Update Sidebar Classes manually since we aren't reloading the page
        document.getElementById('displayTeacherClasses').innerHTML = selected.map(c => `<span class="class-pill">${c}</span>`).join('');
        
        showMsg('settingsClassMsg', 'Classes updated!', false);
    } catch (e) {
        console.error(e);
        showMsg('settingsClassMsg', 'Error saving classes.', true);
    }
    btn.innerHTML = 'Update My Classes';
    btn.disabled = false;
}

// ── 6. GRADE TYPES ──────────────────────────────────────────────────────────
function renderGradeTypesList() {
    const types = getGradeTypes();
    document.getElementById('gradeTypesList').innerHTML = types.map(t => {
        const isDefault = DEFAULT_GRADE_TYPES.includes(t);
        return `
        <div class="flex items-center justify-between bg-white border border-slate-200 rounded-lg p-2 mb-2">
            <span class="font-bold text-slate-700 text-sm">${t}</span>
            ${isDefault ? `<span class="text-[9px] uppercase tracking-wider text-slate-400 font-black px-2 bg-slate-100 rounded">Default</span>` : 
            `<button onclick="deleteGradeType('${t}')" class="text-red-400 hover:text-red-600 transition"><i class="fa-solid fa-trash-can text-xs"></i></button>`}
        </div>`;
    }).join('');
}

window.addGradeType = async function() {
    const input = document.getElementById('newGradeTypeInput');
    const nt = input.value.trim();
    if (!nt) return;
    
    let types = getGradeTypes();
    if (types.map(t => t.toLowerCase()).includes(nt.toLowerCase())) {
        showMsg('gradeTypeMsg', 'Type already exists.', true);
        return;
    }
    
    types.push(nt);
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { customGradeTypes: types });
        session.teacherData.customGradeTypes = types;
        sessionStorage.setItem('connectus_teacher_session', JSON.stringify(session));
        
        input.value = '';
        renderGradeTypesList();
        showMsg('gradeTypeMsg', 'Type added!', false);
    } catch (e) {
        console.error(e);
        showMsg('gradeTypeMsg', 'Error adding type.', true);
    }
};

window.deleteGradeType = async function(type) {
    if (!confirm(`Delete grade type "${type}"?`)) return;
    let types = getGradeTypes().filter(t => t !== type);
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { customGradeTypes: types });
        session.teacherData.customGradeTypes = types;
        sessionStorage.setItem('connectus_teacher_session', JSON.stringify(session));
        renderGradeTypesList();
    } catch (e) {
        console.error(e);
    }
};

// ── 7. SUBJECTS MANAGEMENT ──────────────────────────────────────────────────
function renderSubjectsInSettings() {
    const active = getActiveSubjects();
    const container = document.getElementById('activeSubjectsList');
    
    if (!active.length) {
        container.innerHTML = '<div class="col-span-2 text-center py-6 bg-slate-50 rounded-xl border border-slate-200"><p class="text-sm text-slate-400 italic">No active subjects. Add one using the button above.</p></div>';
        return;
    }
    
    container.innerHTML = active.map(s => `
        <div class="subject-card flex-col">
            <div class="w-full flex justify-between items-start">
                <div class="flex-1 min-w-0"><p class="font-black text-slate-700">${s.name}</p></div>
                <div class="flex items-center gap-2 flex-shrink-0 ml-2">
                    <button onclick="openSubjectFormModal('${s.id}')" class="h-7 w-7 bg-white border border-teal-200 text-teal-600 hover:bg-teal-500 hover:text-white rounded-lg flex items-center justify-center transition" title="Edit"><i class="fa-solid fa-pen text-[10px]"></i></button>
                    <button onclick="archiveSubject('${s.id}')" class="h-7 w-7 bg-white border border-amber-200 text-amber-600 hover:bg-amber-500 hover:text-white rounded-lg flex items-center justify-center transition" title="Archive"><i class="fa-solid fa-box-archive text-[10px]"></i></button>
                </div>
            </div>
            ${s.description ? `<p class="text-xs text-slate-400 font-semibold mt-1 truncate w-full">${s.description}</p>` : ''}
        </div>`).join('');
}

window.openSubjectFormModal = function(subjectId = null) {
    editingSubjectId = subjectId;
    const isEdit = subjectId !== null;
    
    document.getElementById('subjectFormTitle').textContent = isEdit ? 'Edit Subject' : 'Add Subject';
    document.getElementById('subjectFormIcon').className = isEdit ? 'fa-solid fa-pen' : 'fa-solid fa-layer-group';
    
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

window.closeSubjectFormModal = function() { closeOverlay('subjectFormModal', 'subjectFormModalInner'); };

async function saveSubject() {
    const name = document.getElementById('subjectFormName').value.trim();
    const desc = document.getElementById('subjectFormDesc').value.trim();
    
    if (!name) { showMsg('subjectFormMsg', 'Subject name is required.', true); return; }
    
    const btn = document.getElementById('saveSubjectFormBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;
    
    try {
        let newSubs = [...(session.teacherData.subjects || [])];
        
        if (editingSubjectId) {
            const oldSub = newSubs.find(s => s.id === editingSubjectId);
            const oldName = oldSub?.name || '';
            newSubs = newSubs.map(s => s.id === editingSubjectId ? { ...s, name, description: desc } : s);
            
            // If the name changed, we need to batch update all existing grades for all students
            if (oldName && oldName !== name) {
                // Fetch all students to iterate through their grades
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
                    if (batchCount >= 490) { await batch.commit(); batchCount = 0; } // Firestore limit
                }
                if (batchCount > 0) await batch.commit();
            }
        } else {
            if (newSubs.some(s => s.name === name && !s.archived)) {
                showMsg('subjectFormMsg', 'Subject already exists.', true);
                btn.innerHTML = 'Save Subject'; btn.disabled = false;
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
        console.error(e);
        showMsg('subjectFormMsg', 'Error saving subject.', true);
    }
    btn.innerHTML = 'Save Subject';
    btn.disabled = false;
}

window.archiveSubject = async function(subjectId) {
    const sub = (session.teacherData.subjects || []).find(s => s.id === subjectId);
    if (!sub) return;
    if (!confirm(`Archive "${sub.name}"? Existing grades are safe, but it will be moved to Archives.`)) return;
    
    const newSubs = session.teacherData.subjects.map(s => s.id === subjectId ? { ...s, archived: true, archivedAt: new Date().toISOString() } : s);
    await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { subjects: newSubs });
    
    session.teacherData.subjects = newSubs;
    sessionStorage.setItem('connectus_teacher_session', JSON.stringify(session));
    renderSubjectsInSettings();
};

// Fire it up
init();
