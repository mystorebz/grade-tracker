import { db } from '../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { setSessionData } from '../assets/js/auth.js';
import { openOverlay, closeOverlay, showMsg } from '../assets/js/utils.js';

// ── STATE & CONSTANTS ──────────────────────────────────────────────────────
let tempSession = { schoolId: null, teacherId: null, teacherData: null };
let schoolType = 'Primary';

const CLASSES = {
    'Primary': ['Infant 1', 'Infant 2', 'Standard 1', 'Standard 2', 'Standard 3', 'Standard 4', 'Standard 5', 'Standard 6'],
    'High School': ['First Form', 'Second Form', 'Third Form', 'Fourth Form'],
    'Junior College': ['Year 1', 'Year 2']
};

const DEFAULT_SUBJECTS = [
    { id: 'ds1', name: 'Mathematics', description: '', archived: false, archivedAt: null },
    { id: 'ds2', name: 'English Language Arts', description: '', archived: false, archivedAt: null },
    { id: 'ds3', name: 'Science', description: '', archived: false, archivedAt: null },
    { id: 'ds4', name: 'Social Studies', description: '', archived: false, archivedAt: null },
    { id: 'ds5', name: 'Spanish', description: '', archived: false, archivedAt: null },
    { id: 'ds6', name: 'Art', description: '', archived: false, archivedAt: null },
    { id: 'ds7', name: 'Physical Education', description: '', archived: false, archivedAt: null },
    { id: 'ds8', name: 'Health & Family Life', description: '', archived: false, archivedAt: null }
];

function genId() { return 'sub_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5); }

// ── 1. MAIN LOGIN LOGIC ────────────────────────────────────────────────────
document.getElementById('loginBtn').addEventListener('click', async () => {
    const rawId = document.getElementById('loginSchoolId').value.trim();
    const code = document.getElementById('loginTeacherCode').value.trim().toUpperCase();
    const msgEl = document.getElementById('loginMsg');
    const btn = document.getElementById('loginBtn');
    
    msgEl.classList.add('hidden');
    
    if (!rawId || !code) {
        msgEl.textContent = 'Please enter both fields.';
        msgEl.classList.remove('hidden');
        return;
    }
    
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Authenticating...`;
    
    try {
        let foundSchoolId = null;
        let tDoc = null;
        
        // Handle case variations for School ID gracefully
        for (const id of [rawId.toUpperCase(), rawId.toLowerCase(), rawId]) {
            try {
                const q = query(collection(db, 'schools', id, 'teachers'), where('loginCode', '==', code));
                const snap = await getDocs(q);
                if (!snap.empty) {
                    foundSchoolId = id;
                    tDoc = snap.docs[0];
                    break;
                }
            } catch (e) { continue; }
        }
        
        if (!tDoc) {
            msgEl.textContent = 'Invalid School ID or Teacher Code.';
            msgEl.classList.remove('hidden');
            resetLoginBtn(btn);
            return;
        }
        
        const tData = tDoc.data();
        if (tData.archived) {
            msgEl.textContent = 'Your account has been archived.';
            msgEl.classList.remove('hidden');
            resetLoginBtn(btn);
            return;
        }
        
        const schoolSnap = await getDoc(doc(db, 'schools', foundSchoolId));
        if (!schoolSnap.exists() || schoolSnap.data().isVerified !== true) {
            msgEl.textContent = 'School account pending approval.';
            msgEl.classList.remove('hidden');
            resetLoginBtn(btn);
            return;
        }
        
        schoolType = schoolSnap.data().schoolType || 'Primary';
        tempSession = { schoolId: foundSchoolId, teacherId: tDoc.id, teacherData: tData };
        
        // Determine Next Step in Flow
        document.getElementById('loginScreen').style.display = 'none';
        
        // Check if the classes array exists AND is actually empty
        const needsClasses = !tData.classes || tData.classes.length === 0;

        if (tData.requiresPinReset) {
            openOverlay('forceResetModal', 'forceResetModalInner');
        } else if (needsClasses) {
            triggerOnboarding();
        } else {
            finalizeLogin();
        }
        
    } catch (e) {
        console.error(e);
        msgEl.textContent = 'Connection error. Please try again.';
        msgEl.classList.remove('hidden');
        resetLoginBtn(btn);
    }
});

function resetLoginBtn(btn) {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-arrow-right-to-bracket"></i> Access Portal`;
}

// ── 2. FORCE RESET LOGIN CODE ──────────────────────────────────────────────
document.getElementById('saveForceCodeBtn').addEventListener('click', async () => {
    const n = document.getElementById('newForceCode').value.trim();
    const c = document.getElementById('confirmForceCode').value.trim();
    const msg = document.getElementById('forceResetMsg');
    
    if (!n || !c) { msg.textContent = 'Fill both fields.'; msg.classList.remove('hidden'); return; }
    if (n !== c) { msg.textContent = 'Codes do not match.'; msg.classList.remove('hidden'); return; }
    if (n.length < 5) { msg.textContent = 'Minimum 5 characters.'; msg.classList.remove('hidden'); return; }
    
    const btn = document.getElementById('saveForceCodeBtn');
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    
    await updateDoc(doc(db, 'schools', tempSession.schoolId, 'teachers', tempSession.teacherId), {
        loginCode: n,
        requiresPinReset: false
    });
    
    tempSession.teacherData.loginCode = n;
    tempSession.teacherData.requiresPinReset = false;
    
    closeOverlay('forceResetModal', 'forceResetModalInner');
    
    setTimeout(() => {
        // Same strict check for empty arrays here
        const needsClasses = !tempSession.teacherData.classes || tempSession.teacherData.classes.length === 0;
        
        if (needsClasses) {
            triggerOnboarding();
        } else {
            finalizeLogin();
        }
    }, 350);
    
    btn.innerHTML = `Save & Continue <i class="fa-solid fa-arrow-right"></i>`;
    btn.disabled = false;
});

// ── 3. FIRST TIME ONBOARDING (CLASS SELECTION) ─────────────────────────────
function triggerOnboarding() {
    const classList = CLASSES[schoolType] || CLASSES['Primary'];
    document.getElementById('onboardSubtitle').textContent = `Select the class${classList.length > 1 ? '(es)' : ''} you teach at ${schoolType} level.`;
    
    document.getElementById('classGrid').innerHTML = classList.map(c => `
        <div class="cls-cb-item" id="wrap-${c.replace(/\s/g, '_')}" onclick="toggleClassCb('${c.replace(/\s/g, '_')}', '${c}')">
            <input type="checkbox" id="cb-${c.replace(/\s/g, '_')}" value="${c}">
            <label for="cb-${c.replace(/\s/g, '_')}" onclick="event.stopPropagation()">${c}</label>
        </div>`).join('');
        
    openOverlay('onboardModal', 'onboardModalInner');
}

// Attach to window so inline HTML onclicks can find it
window.toggleClassCb = function(safeId, className) {
    const cb = document.getElementById('cb-' + safeId);
    const wrap = document.getElementById('wrap-' + safeId);
    cb.checked = !cb.checked;
    wrap.classList.toggle('selected', cb.checked);
};

document.getElementById('saveClassBtn').addEventListener('click', async () => {
    const selected = [...document.querySelectorAll('#classGrid input[type=checkbox]:checked')].map(c => c.value);
    
    if (!selected.length) {
        document.getElementById('onboardErr').classList.remove('hidden');
        return;
    }
    document.getElementById('onboardErr').classList.add('hidden');
    
    const btn = document.getElementById('saveClassBtn');
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;
    
    await updateDoc(doc(db, 'schools', tempSession.schoolId, 'teachers', tempSession.teacherId), {
        classes: selected,
        className: selected[0]
    });
    
    tempSession.teacherData.classes = selected;
    tempSession.teacherData.className = selected[0];
    
    closeOverlay('onboardModal', 'onboardModalInner');
    
    setTimeout(() => finalizeLogin(), 350);
    
    btn.innerHTML = `<i class="fa-solid fa-check mr-2"></i>Save & Enter Portal`;
    btn.disabled = false;
});

// ── 4. FINALIZE LOGIN & REDIRECT ───────────────────────────────────────────
async function finalizeLogin() {
    // Safety check for legacy teachers missing a classes array
    if (!tempSession.teacherData.classes || tempSession.teacherData.classes.length === 0) {
        const classes = tempSession.teacherData.className ? [tempSession.teacherData.className] : [];
        await updateDoc(doc(db, 'schools', tempSession.schoolId, 'teachers', tempSession.teacherId), { classes });
        tempSession.teacherData.classes = classes;
    }
    
    // Set global cache for classes instantly
    localStorage.setItem('connectus_cached_classes', JSON.stringify(tempSession.teacherData.classes));
    
    // Safety check: Migrate legacy string subjects to object structure
    if (tempSession.teacherData.subjects?.length && typeof tempSession.teacherData.subjects[0] === 'string') {
        const migrated = tempSession.teacherData.subjects.map(name => ({ id: genId(), name, description: '', archived: false, archivedAt: null }));
        await updateDoc(doc(db, 'schools', tempSession.schoolId, 'teachers', tempSession.teacherId), { subjects: migrated });
        tempSession.teacherData.subjects = migrated;
    }
    
    // Safety check: Default subjects if empty
    if (!tempSession.teacherData.subjects || !tempSession.teacherData.subjects.length) {
        await updateDoc(doc(db, 'schools', tempSession.schoolId, 'teachers', tempSession.teacherId), { subjects: DEFAULT_SUBJECTS });
        tempSession.teacherData.subjects = DEFAULT_SUBJECTS;
    }

    // Save session using auth.js
    setSessionData('teacher', tempSession);
    
    // Redirect to the new modular Dashboard
    window.location.href = 'home/home.html';
}
