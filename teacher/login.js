import { db, auth } from '../assets/js/firebase-init.js';
import { doc, getDoc, updateDoc }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { signInWithCustomToken, signOut }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFunctions, httpsCallable }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { setSessionData } from '../assets/js/auth.js';
import { openOverlay, closeOverlay } from '../assets/js/utils.js';

// ── WIPE ANY STALE SESSION THE MOMENT THE LOGIN PAGE LOADS ───────────────────
signOut(auth).catch(() => {});

// ── Functions instance ────────────────────────────────────────────────────────
const functions        = getFunctions();
const mintTeacherToken = httpsCallable(functions, 'mintTeacherToken');

// ── State & Constants ─────────────────────────────────────────────────────────
let tempSession     = { schoolId: null, teacherId: null, teacherData: null };
let schoolType      = 'Primary';
let isGlobalTeacher = false;

const DEFAULT_SUBJECTS = [
    { id: 'ds1', name: 'Mathematics',          description: '', archived: false, archivedAt: null },
    { id: 'ds2', name: 'English Language Arts', description: '', archived: false, archivedAt: null },
    { id: 'ds3', name: 'Science',              description: '', archived: false, archivedAt: null },
    { id: 'ds4', name: 'Social Studies',       description: '', archived: false, archivedAt: null },
    { id: 'ds5', name: 'Spanish',              description: '', archived: false, archivedAt: null },
    { id: 'ds6', name: 'Art',                  description: '', archived: false, archivedAt: null },
    { id: 'ds7', name: 'Physical Education',   description: '', archived: false, archivedAt: null },
    { id: 'ds8', name: 'Health & Family Life', description: '', archived: false, archivedAt: null }
];

function genId() { return 'sub_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5); }

// ── SHA-256 (trim only — matches sha256Trim on the server) ────────────────────
async function sha256Trim(text) {
    const encoded    = new TextEncoder().encode(String(text).trim());
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// ── 1. MAIN LOGIN ─────────────────────────────────────────────────────────────
document.getElementById('loginBtn').addEventListener('click', async () => {
    const rawId = document.getElementById('loginSchoolId').value.trim();
    const pin   = document.getElementById('loginTeacherCode').value.trim(); // raw — no casing, no hashing
    const msgEl = document.getElementById('loginMsg');
    const btn   = document.getElementById('loginBtn');

    msgEl.classList.add('hidden');

    if (!rawId || !pin) {
        msgEl.textContent = 'Please enter both fields.';
        msgEl.classList.remove('hidden');
        return;
    }

    btn.disabled  = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Authenticating...`;

    try {
        // ── 1. CF IS THE GATEKEEPER — send raw PIN, server hashes and verifies ──
        let authResult;
        try {
            authResult = await mintTeacherToken({ schoolId: rawId, pin });
            await signInWithCustomToken(auth, authResult.data.token);
        } catch (authError) {
            console.error('[Teacher Login] Server rejected credentials:', authError);
            msgEl.textContent = 'Invalid School ID or Teacher Code.';
            msgEl.classList.remove('hidden');
            resetLoginBtn(btn);
            return;
        }

        // ── 2. SERVER VERIFIED — now fetch teacher data ───────────────────────
        const teacherId = authResult.data.teacherId;
        const schoolId  = authResult.data.schoolId || rawId.toUpperCase();
        isGlobalTeacher = !authResult.data.legacy;

        let tData = null;
        if (isGlobalTeacher) {
            const tSnap = await getDoc(doc(db, 'teachers', teacherId));
            tData = tSnap.exists() ? tSnap.data() : null;
        } else {
            const tSnap = await getDoc(doc(db, 'schools', schoolId, 'teachers', teacherId));
            tData = tSnap.exists() ? tSnap.data() : null;
        }

        if (!tData) {
            msgEl.textContent = 'Could not load teacher profile. Please try again.';
            msgEl.classList.remove('hidden');
            resetLoginBtn(btn);
            return;
        }

        if (tData.archived) {
            msgEl.textContent = 'Your account has been archived. Contact your administrator.';
            msgEl.classList.remove('hidden');
            resetLoginBtn(btn);
            return;
        }

        const schoolSnap = await getDoc(doc(db, 'schools', schoolId));
        schoolType  = schoolSnap.data()?.schoolType || 'Primary';
        tempSession = { schoolId, teacherId, teacherData: tData };

        // ── Check if PIN reset is required ────────────────────────────────────
        if (tData.requiresPinReset) {
            resetLoginBtn(btn);
            openOverlay('forceResetModal', 'forceResetModalInner');
        } else {
            await finalizeLogin();
        }

    } catch (e) {
        console.error('[Teacher Login] Outer catch:', e);
        msgEl.textContent = 'Connection error. Please try again.';
        msgEl.classList.remove('hidden');
        resetLoginBtn(btn);
    }
});

function resetLoginBtn(btn) {
    btn.disabled  = false;
    btn.innerHTML = `<i class="fa-solid fa-arrow-right-to-bracket"></i> Access Portal`;
}

// ── 2. FORCE RESET ────────────────────────────────────────────────────────────
document.getElementById('saveForceCodeBtn').addEventListener('click', async () => {
    const n   = document.getElementById('newForceCode').value.trim();
    const c   = document.getElementById('confirmForceCode').value.trim();
    const msg = document.getElementById('forceResetMsg');

    if (!n || !c)     { msg.textContent = 'Fill both fields.';      msg.classList.remove('hidden'); return; }
    if (n !== c)      { msg.textContent = 'Codes do not match.';    msg.classList.remove('hidden'); return; }
    if (n.length < 5) { msg.textContent = 'Minimum 5 characters.'; msg.classList.remove('hidden'); return; }

    const btn = document.getElementById('saveForceCodeBtn');
    btn.disabled  = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;

    try {
        // Hash before writing — plain text never touches Firestore
        const hashedNew = await sha256Trim(n);

        if (isGlobalTeacher) {
            await updateDoc(doc(db, 'teachers', tempSession.teacherId), {
                pin: hashedNew, requiresPinReset: false
            });
        } else {
            await updateDoc(doc(db, 'schools', tempSession.schoolId, 'teachers', tempSession.teacherId), {
                loginCode: hashedNew, requiresPinReset: false
            });
        }
    } catch (e) {
        console.error('[Teacher Login] Force reset save failed:', e);
        msg.textContent = 'Failed to save new PIN. Please try again.';
        msg.classList.remove('hidden');
        btn.innerHTML = `Save & Continue <i class="fa-solid fa-arrow-right"></i>`;
        btn.disabled  = false;
        return;
    }

    tempSession.teacherData.requiresPinReset = false;

    // UX: clear fields, close modal, prompt fresh login like admin does
    document.getElementById('newForceCode').value    = '';
    document.getElementById('confirmForceCode').value = '';
    document.getElementById('loginTeacherCode').value = '';

    closeOverlay('forceResetModal', 'forceResetModalInner');

    btn.innerHTML = `Save & Continue <i class="fa-solid fa-arrow-right"></i>`;
    btn.disabled  = false;

    // Show success and let them log in fresh with new PIN
    const msgEl = document.getElementById('loginMsg');
    msgEl.textContent = 'PIN updated successfully. Please log in with your new PIN.';
    msgEl.classList.remove('hidden');
});

// ── 3. FINALIZE LOGIN (Routing) ───────────────────────────────────────────────
async function finalizeLogin() {
    try {
        const currentClasses = tempSession.teacherData.classes || [];
        localStorage.setItem('connectus_cached_classes', JSON.stringify(currentClasses));

        // Migrate legacy string subjects to objects
        if (tempSession.teacherData.subjects?.length && typeof tempSession.teacherData.subjects[0] === 'string') {
            const migrated  = tempSession.teacherData.subjects.map(name =>
                ({ id: genId(), name, description: '', archived: false, archivedAt: null })
            );
            const updateRef = isGlobalTeacher
                ? doc(db, 'teachers', tempSession.teacherId)
                : doc(db, 'schools', tempSession.schoolId, 'teachers', tempSession.teacherId);
            await updateDoc(updateRef, { subjects: migrated });
            tempSession.teacherData.subjects = migrated;
        }

        // Apply default subjects if totally empty
        if (!tempSession.teacherData.subjects || !tempSession.teacherData.subjects.length) {
            const updateRef = isGlobalTeacher
                ? doc(db, 'teachers', tempSession.teacherId)
                : doc(db, 'schools', tempSession.schoolId, 'teachers', tempSession.teacherId);
            await updateDoc(updateRef, { subjects: DEFAULT_SUBJECTS });
            tempSession.teacherData.subjects = DEFAULT_SUBJECTS;
        }
    } catch (e) {
        console.warn('[Teacher Login] finalizeLogin migration warning:', e.message);
    }

    setSessionData('teacher', tempSession);

    // Gate 1: Profile completion
    if (isGlobalTeacher && tempSession.teacherData.profileComplete === false) {
        window.location.href = 'onboarding/onboarding.html';
        return;
    }

    // Gate 2: Security questions
    if (isGlobalTeacher && !tempSession.teacherData.securityQuestionsSet) {
        window.location.href = '../onboarding/first-time-setup.html?role=teacher';
        return;
    }

    // Gate 3: Home
    window.location.href = 'home/home.html';
}
