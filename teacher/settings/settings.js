import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, updateDoc, collection, query, where, getDocs, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
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

// Filters for Active vs Archived
function getActiveSubjects() { return (session.teacherData.subjects || []).filter(s => !s.archived); }
function getArchivedSubjects() { return (session.teacherData.subjects || []).filter(s => s.archived); }

// Active vs Archived Grade Types
function getGradeTypes() { 
    return session.teacherData.customGradeTypes || DEFAULT_GRADE_TYPES;
}
function getArchivedGradeTypes() {
    return session.teacherData.archivedGradeTypes || [];
}

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

    try {
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolSnap.exists()) {
            schoolType = schoolSnap.data().schoolType || 'Primary';
        }
    } catch (e) { 
        console.error("[Settings] Error fetching school data", e); 
    }

    await loadSemesters();
    loadSettings();

    document.getElementById('updateCodeBtn').addEventListener('click', updateLoginCode);
    document.getElementById('saveProfileBtn').addEventListener('click', saveProfile);
    document.getElementById('saveClassesBtn').addEventListener('click', saveClasses);
    document.getElementById('saveSubjectFormBtn').addEventListener('click', saveSubject);

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

// ── 3.5. LOAD SEMESTERS ─────────────────────────────────────────────────────
async function loadSemesters() {
    try {
        let rawSemesters = [];
        const cacheKey   = `connectus_semesters_${session.schoolId}`;
        const cached     = localStorage.getItem(cacheKey);

        if (cached) {
            rawSemesters = JSON.parse(cached);
        } else {
            const semSnap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            rawSemesters  = semSnap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => (a.order || 0) - (b.order || 0));
            localStorage.setItem(cacheKey, JSON.stringify(rawSemesters));
        }

        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        const activeId   = schoolSnap.data()?.activeSemesterId || '';

        const semSel = document.getElementById('activeSemester');
        if (semSel) {
            semSel.innerHTML = '';
            rawSemesters.forEach(s => {
                const opt      = document.createElement('option');
                opt.value      = s.id;
                opt.textContent = s.name;
                if (s.id === activeId) opt.selected = true;
                semSel.appendChild(opt);
            });

            const sbPeriod = document.getElementById('sb-period');
            if (sbPeriod) sbPeriod.textContent = semSel.options[semSel.selectedIndex]?.text || '—';

            semSel.addEventListener('change', () => {
                if (sbPeriod) sbPeriod.textContent = semSel.options[semSel.selectedIndex]?.text || '—';
            });
        }
    } catch (e) {
        console.error('[Settings] loadSemesters:', e);
    }
}

function loadSettings() {
    document.getElementById('profileIdNum').value = session.teacherData.teacherIdNum || 'Not assigned';
    document.getElementById('profileName').value = session.teacherData.name || '';
    document.getElementById('profileEmail').value = session.teacherData.email || '';
    document.getElementById('profilePhone').value = session.teacherData.phone || '';
    toggleSecurityEdit(false);
    toggleProfileEdit(false);

    const classes = getClasses().filter(Boolean);
    document.getElementById('currentClassesDisplay').textContent = classes.join(', ') || 'Not set';
    const classList = CLASSES[schoolType] || CLASSES['Primary'];
    
    document.getElementById('settingsClassGrid').innerHTML = classList.map(c => {
        const safeId = c.replace(/\s/g, '_');
        const isChecked = classes.includes(c);
        return `
        <label class="flex items-center gap-3 p-3 border border-[#dce3ed] rounded cursor-pointer hover:bg-white transition ${isChecked ? 'bg-[#eef4ff] border-[#c7d9fd] shadow-sm' : 'bg-white'}" id="swrap-${safeId}">
            <input type="checkbox" id="scb-${safeId}" value="${c}" ${isChecked ? 'checked' : ''} onchange="toggleClassVisuals('${safeId}')" class="w-4 h-4 text-[#2563eb] rounded border-[#b8c5d4] focus:ring-[#2563eb]">
            <span class="font-bold text-[#0d1f35] text-[13px] select-none">${c}</span>
        </label>`;
    }).join('');

    renderGradeTypesList();
    renderSubjectsInSettings();
}

// ── 4. PROFILE & SECURITY ───────────────────────────────────────────────────
window.toggleSecurityEdit = function(isEditing) {
    ['currentTeacherCode', 'newTeacherCode', 'confirmTeacherCode'].forEach(id => {
        const el = document.getElementById(id);
        el.disabled = !isEditing;
        if (!isEditing) el.value = '';
        el.classList.toggle('bg-[#f8fafb]', !isEditing);
        el.classList.toggle('bg-white', isEditing);
    });
    document.getElementById('securityEditBtn').classList.toggle('hidden', isEditing);
    document.getElementById('securityActionBtns').classList.toggle('hidden', !isEditing);
    document.getElementById('settingsSecurityMsg').classList.add('hidden');
};

window.toggleProfileEdit = function(isEditing) {
    ['profileName', 'profileEmail', 'profilePhone'].forEach(id => {
        const el = document.getElementById(id);
        el.disabled = !isEditing;
        el.classList.toggle('bg-[#f8fafb]', !isEditing);
        el.classList.toggle('bg-white', isEditing);
    });
    
    if (!isEditing) {
        document.getElementById('profileName').value = session.teacherData.name || '';
        document.getElementById('profileEmail').value = session.teacherData.email || '';
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
        setSessionData('teacher', session);
        
        toggleSecurityEdit(false);
        showMsg(mid, 'Login code updated successfully!', false);
    } catch (e) {
        showMsg(mid, 'Error saving new code. Please try again.', true);
    }
    btn.innerHTML = originalText;
    btn.disabled = false;
}

async function saveProfile() {
    const u = {
        name: document.getElementById('profileName').value.trim(),
        email: document.getElementById('profileEmail').value.trim(),
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
        setSessionData('teacher', session);
        
        const sbName = document.getElementById('displayTeacherName');
        const sbAvatar = document.getElementById('teacherAvatar');
        if (sbName) sbName.textContent = u.name;
        if (sbAvatar) sbAvatar.textContent = u.name.charAt(0).toUpperCase();
        
        toggleProfileEdit(false);
        showMsg('settingsProfileMsg', 'Profile saved successfully!', false);
    } catch (e) {
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
        wrap.classList.add('bg-[#eef4ff]', 'border-[#c7d9fd]', 'shadow-sm');
        wrap.classList.remove('bg-white');
    } else {
        wrap.classList.remove('bg-[#eef4ff]', 'border-[#c7d9fd]', 'shadow-sm');
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
            className: selected[0] 
        });
        
        session.teacherData.classes = selected;
        session.teacherData.className = selected[0];
        
        setSessionData('teacher', session);
        localStorage.setItem('connectus_cached_classes', JSON.stringify(selected));
        
        document.getElementById('currentClassesDisplay').textContent = selected.join(', ');
        
        const sbClasses = document.getElementById('displayTeacherClasses');
        if (sbClasses) {
            sbClasses.innerHTML = selected.map(c => `<span class="class-pill">${escHtml(c)}</span>`).join('');
        }
        
        showMsg('settingsClassMsg', 'Classes updated successfully!', false);
    } catch (e) {
        showMsg('settingsClassMsg', 'Error saving classes. Please try again.', true);
    }
    btn.innerHTML = originalText;
    btn.disabled = false;
}

// ── 6. GRADE TYPES (WITH VISIBLE ARCHIVES) ──────────────────────────────────
function renderGradeTypesList() {
    const active = getGradeTypes();
    const archived = getArchivedGradeTypes();
    
    // Render Active
    document.getElementById('gradeTypesList').innerHTML = active.map(t => `
        <div class="flex items-center justify-between bg-white border border-[#dce3ed] rounded p-2.5 mb-2 shadow-sm transition hover:border-[#c7d9fd]">
            <span class="font-bold text-[#0d1f35] text-[13px]">${escHtml(t)}</span>
            <button onclick="archiveGradeType('${escHtml(t).replace(/'/g, "\\'")}')" class="text-[#9ab0c6] hover:text-[#b45309] hover:bg-[#fef3c7] p-1.5 rounded transition" title="Archive Type">
                <i class="fa-solid fa-box-archive text-[11px]"></i>
            </button>
        </div>`
    ).join('') || '<p class="text-[11.5px] text-[#9ab0c6] italic mb-0">No active grade types.</p>';

    // Render Archived (if any)
    const archivedWrap = document.getElementById('archivedGradeTypesWrap');
    if (archived.length > 0) {
        archivedWrap.classList.remove('hidden');
        document.getElementById('archivedGradeTypesList').innerHTML = archived.map(t => `
            <div class="flex items-center justify-between bg-[#f8fafb] border border-[#e2e8f0] rounded p-2 mb-2">
                <span class="font-bold text-[#6b84a0] text-[12px] line-through decoration-[#b8c5d4]">${escHtml(t)}</span>
                <div class="flex gap-1">
                    <button onclick="restoreGradeType('${escHtml(t).replace(/'/g, "\\'")}')" class="text-[#9ab0c6] hover:text-[#0ea871] hover:bg-[#edfaf4] p-1 rounded transition" title="Restore">
                        <i class="fa-solid fa-arrow-rotate-left text-[11px]"></i>
                    </button>
                    <button onclick="deleteGradeTypePermanently('${escHtml(t).replace(/'/g, "\\'")}')" class="text-[#9ab0c6] hover:text-[#e31b4a] hover:bg-[#fff0f3] p-1 rounded transition" title="Delete Permanently">
                        <i class="fa-solid fa-trash-can text-[11px]"></i>
                    </button>
                </div>
            </div>`
        ).join('');
    } else {
        archivedWrap.classList.add('hidden');
    }
}

window.addGradeType = async function() {
    const input = document.getElementById('newGradeTypeInput');
    const nt = input.value.trim();
    if (!nt) return;
    
    let activeTypes = getGradeTypes();
    if (activeTypes.map(t => t.toLowerCase()).includes(nt.toLowerCase())) {
        showMsg('gradeTypeMsg', 'This grade type is already active.', true);
        return;
    }
    
    const btn = input.nextElementSibling;
    const originalIcon = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
    btn.disabled = true;

    activeTypes.push(nt);

    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { customGradeTypes: activeTypes });
        session.teacherData.customGradeTypes = activeTypes;
        setSessionData('teacher', session);
        
        input.value = '';
        renderGradeTypesList();
        showMsg('gradeTypeMsg', 'Grade type added!', false);
    } catch (e) {
        showMsg('gradeTypeMsg', 'Error adding grade type. Please try again.', true);
        activeTypes.pop(); 
    }
    btn.innerHTML = originalIcon;
    btn.disabled = false;
};

window.archiveGradeType = async function(type) {
    let activeTypes = getGradeTypes().filter(t => t !== type);
    let archivedTypes = getArchivedGradeTypes();
    
    if (!archivedTypes.includes(type)) {
        archivedTypes.push(type);
    }
    
    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { 
            customGradeTypes: activeTypes,
            archivedGradeTypes: archivedTypes
        });
        
        session.teacherData.customGradeTypes = activeTypes;
        session.teacherData.archivedGradeTypes = archivedTypes;
        setSessionData('teacher', session);
        
        renderGradeTypesList();
        showMsg('gradeTypeMsg', `Archived "${type}".`, false);
    } catch (e) {
        showMsg('gradeTypeMsg', 'Error archiving type.', true);
    }
};

window.restoreGradeType = async function(type) {
    let archivedTypes = getArchivedGradeTypes().filter(t => t !== type);
    let activeTypes = getGradeTypes();
    
    if (!activeTypes.includes(type)) {
        activeTypes.push(type);
    }

    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { 
            customGradeTypes: activeTypes,
            archivedGradeTypes: archivedTypes
        });
        
        session.teacherData.customGradeTypes = activeTypes;
        session.teacherData.archivedGradeTypes = archivedTypes;
        setSessionData('teacher', session);
        
        renderGradeTypesList();
        showMsg('gradeTypeMsg', `Restored "${type}".`, false);
    } catch (e) {
        showMsg('gradeTypeMsg', 'Error restoring type.', true);
    }
};

window.deleteGradeTypePermanently = async function(type) {
    if (!confirm(`Are you sure you want to permanently delete "${type}"?\nThis cannot be undone.`)) return;
    
    let archivedTypes = getArchivedGradeTypes().filter(t => t !== type);

    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { 
            archivedGradeTypes: archivedTypes
        });
        
        session.teacherData.archivedGradeTypes = archivedTypes;
        setSessionData('teacher', session);
        
        renderGradeTypesList();
        showMsg('gradeTypeMsg', `Permanently deleted "${type}".`, false);
    } catch (e) {
        showMsg('gradeTypeMsg', 'Error deleting type.', true);
    }
};

// ── 7. SUBJECTS MANAGEMENT (WITH VISIBLE ARCHIVES) ──────────────────────────
function renderSubjectsInSettings() {
    const active = getActiveSubjects();
    const archived = getArchivedSubjects();
    
    const activeContainer = document.getElementById('activeSubjectsList');
    const archivedWrap = document.getElementById('archivedSubjectsWrap');
    const archivedContainer = document.getElementById('archivedSubjectsList');
    
    // Render Active Subjects
    if (!active.length) {
        activeContainer.innerHTML = '<div class="col-span-1 md:col-span-2 xl:col-span-3 text-center py-10 bg-[#f8fafb] rounded border border-dashed border-[#b8c5d4]"><div class="w-10 h-10 bg-white text-[#9ab0c6] border border-[#dce3ed] rounded-full flex items-center justify-center mx-auto mb-3"><i class="fa-solid fa-book-open"></i></div><p class="text-[13px] font-bold text-[#374f6b] m-0">No active subjects</p><p class="text-[11.5px] text-[#6b84a0] m-0 mt-1">Add your first subject to build your curriculum.</p></div>';
    } else {
        activeContainer.innerHTML = active.map(s => `
            <div class="bg-white border border-[#dce3ed] hover:border-[#0d1f35] rounded p-4 shadow-sm transition flex flex-col group">
                <div class="w-full flex justify-between items-start mb-2">
                    <div class="flex-1 min-w-0 pr-2">
                        <p class="font-bold text-[#0d1f35] text-[14px] m-0 truncate">${escHtml(s.name)}</p>
                    </div>
                    <div class="flex items-center gap-1.5 flex-shrink-0 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
                        <button onclick="openSubjectFormModal('${s.id}')" class="h-7 w-7 bg-white border border-[#c5d0db] text-[#374f6b] hover:bg-[#0d1f35] hover:text-white rounded flex items-center justify-center transition" title="Edit Subject"><i class="fa-solid fa-pen text-[10px]"></i></button>
                        <button onclick="archiveSubject('${s.id}', '${escHtml(s.name).replace(/'/g, "\\'")}')" class="h-7 w-7 bg-white border border-[#fde68a] text-[#b45309] hover:bg-[#f59e0b] hover:text-white rounded flex items-center justify-center transition" title="Archive Subject"><i class="fa-solid fa-box-archive text-[10px]"></i></button>
                    </div>
                </div>
                ${s.description ? `<p class="text-[11.5px] text-[#6b84a0] font-medium leading-relaxed line-clamp-2 m-0">${escHtml(s.description)}</p>` : `<p class="text-[11.5px] text-[#9ab0c6] italic m-0">No description provided</p>`}
            </div>`).join('');
    }

    // Render Archived Subjects
    if (archived.length > 0) {
        archivedWrap.classList.remove('hidden');
        archivedContainer.innerHTML = archived.map(s => `
            <div class="bg-[#f8fafb] border border-[#e2e8f0] rounded p-4 flex flex-col opacity-75 hover:opacity-100 transition">
                <div class="w-full flex justify-between items-start mb-2">
                    <div class="flex-1 min-w-0 pr-2">
                        <p class="font-bold text-[#6b84a0] text-[14px] m-0 line-through decoration-[#b8c5d4] truncate">${escHtml(s.name)}</p>
                    </div>
                    <div class="flex items-center gap-1.5 flex-shrink-0">
                        <button onclick="restoreSubject('${s.id}', '${escHtml(s.name).replace(/'/g, "\\'")}')" class="h-7 w-7 bg-white border border-[#c6f0db] text-[#0ea871] hover:bg-[#0ea871] hover:text-white rounded flex items-center justify-center transition" title="Restore Subject"><i class="fa-solid fa-arrow-rotate-left text-[10px]"></i></button>
                        <button onclick="deleteSubjectPermanently('${s.id}', '${escHtml(s.name).replace(/'/g, "\\'")}')" class="h-7 w-7 bg-white border border-[#fecaca] text-[#e31b4a] hover:bg-[#e31b4a] hover:text-white rounded flex items-center justify-center transition" title="Delete Permanently"><i class="fa-solid fa-trash-can text-[10px]"></i></button>
                    </div>
                </div>
                <p class="text-[10px] text-[#9ab0c6] font-bold uppercase tracking-widest m-0">Archived: ${s.archivedAt ? new Date(s.archivedAt).toLocaleDateString() : 'Unknown'}</p>
            </div>`).join('');
    } else {
        archivedWrap.classList.add('hidden');
    }
}

window.openSubjectFormModal = function(subjectId = null) {
    editingSubjectId = subjectId;
    const isEdit = subjectId !== null;
    
    document.getElementById('subjectFormTitle').textContent = isEdit ? 'Edit Subject' : 'Add Subject';
    document.getElementById('subjectFormIcon').className = isEdit ? 'fa-solid fa-pen text-[13px]' : 'fa-solid fa-layer-group text-[13px]';
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
            
            if (oldName && oldName !== name) {
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
                    if (batchCount >= 490) { 
                        await batch.commit(); 
                        batchCount = 0; 
                    }
                }
                if (batchCount > 0) await batch.commit();
            }
        } else {
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
        setSessionData('teacher', session);
        
        closeSubjectFormModal();
        renderSubjectsInSettings();
        showMsg('subjectsMsg', 'Curriculum updated!', false);
    } catch (e) {
        showMsg('subjectFormMsg', 'Error saving subject.', true);
    }
    btn.innerHTML = originalText;
    btn.disabled = false;
}

window.archiveSubject = async function(subjectId, subjectName) {
    if (!confirm(`Archive "${subjectName}"?\n\nIt will be moved to the Archived Subjects section below.`)) return;
    
    try {
        const newSubs = session.teacherData.subjects.map(s => s.id === subjectId ? { ...s, archived: true, archivedAt: new Date().toISOString() } : s);
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { subjects: newSubs });
        
        session.teacherData.subjects = newSubs;
        setSessionData('teacher', session);
        renderSubjectsInSettings();
    } catch (e) {
        alert('Failed to archive subject.');
    }
};

window.restoreSubject = async function(subjectId, subjectName) {
    if (!confirm(`Restore "${subjectName}" back to active subjects?`)) return;
    
    try {
        const newSubs = session.teacherData.subjects.map(s => s.id === subjectId ? { ...s, archived: false, archivedAt: null } : s);
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { subjects: newSubs });
        
        session.teacherData.subjects = newSubs;
        setSessionData('teacher', session);
        renderSubjectsInSettings();
    } catch (e) {
        alert('Failed to restore subject.');
    }
};

window.deleteSubjectPermanently = async function(subjectId, subjectName) {
    if (!confirm(`Are you absolutely sure you want to permanently delete "${subjectName}"?\n\nWARNING: If you have existing grades tied to this subject, they will lose their category association. This cannot be undone.`)) return;
    
    try {
        const newSubs = session.teacherData.subjects.filter(s => s.id !== subjectId);
        await updateDoc(doc(db, 'schools', session.schoolId, 'teachers', session.teacherId), { subjects: newSubs });
        
        session.teacherData.subjects = newSubs;
        setSessionData('teacher', session);
        renderSubjectsInSettings();
    } catch (e) {
        alert('Failed to delete subject.');
    }
};

// Fire initialization
init();
