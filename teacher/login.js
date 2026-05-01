import { db, auth } from '../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, updateDoc }
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

// ── 1. MAIN LOGIN ─────────────────────────────────────────────────────────────
document.getElementById('loginBtn').addEventListener('click', async () => {
    const rawId = document.getElementById('loginSchoolId').value.trim();
    const code  = document.getElementById('loginTeacherCode').value.trim().toUpperCase();
    const msgEl = document.getElementById('loginMsg');
    const btn   = document.getElementById('loginBtn');

    msgEl.classList.add('hidden');

    if (!rawId || !code) {
        msgEl.textContent = 'Please enter both fields.';
        msgEl.classList.remove('hidden');
        return;
    }

    btn.disabled  = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Authenticating...`;

    try {
        let foundSchoolId = null;
        let tId           = null;
        let tData         = null;
        isGlobalTeacher   = false;

        // ── Try global /teachers first ────────────────────────────────────────
        for (const schoolId of [rawId.toUpperCase(), rawId.toLowerCase(), rawId]) {
            try {
                const globalQ    = query(
                    collection(db, 'teachers'),
                    where('currentSchoolId', '==', schoolId),
                    where('pin', '==', code)
                );
                const globalSnap = await getDocs(globalQ);
                if (!globalSnap.empty) {
                    foundSchoolId   = schoolId;
                    tId             = globalSnap.docs[0].id;
                    tData           = globalSnap.docs[0].data();
                    isGlobalTeacher = true;
                    break;
                }
            } catch (e) {
                console.warn('[Teacher Login] Global query failed for', schoolId, e.message);
            }
        }

        // ── Fall back to legacy siloed path ───────────────────────────────────
        if (!foundSchoolId) {
            for (const schoolId of [rawId.toUpperCase(), rawId.toLowerCase(), rawId]) {
                try {
                    const legacyQ    = query(
                        collection(db, 'schools', schoolId, 'teachers'),
                        where('loginCode', '==', code)
                    );
                    const legacySnap = await getDocs(legacyQ);
                    if (!legacySnap.empty) {
                        foundSchoolId = schoolId;
                        tId           = legacySnap.docs[0].id;
                        tData         = legacySnap.docs[0].data();
                        break;
                    }
                } catch (e) {
                    console.warn('[Teacher Login] Legacy query failed for', schoolId, e.message);
                    continue;
                }
            }
        }

        // ── No match found — hard stop ────────────────────────────────────────
        if (!foundSchoolId || !tData) {
            msgEl.textContent = 'Invalid School ID or Teacher Code.';
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

        const schoolSnap = await getDoc(doc(db, 'schools', foundSchoolId));
        if (!schoolSnap.exists() || schoolSnap.data().isVerified !== true) {
            msgEl.textContent = 'School account is pending approval.';
            msgEl.classList.remove('hidden');
            resetLoginBtn(btn);
            return;
        }

        schoolType  = schoolSnap.data().schoolType || 'Primary';
        tempSession = { schoolId: foundSchoolId, teacherId: tId, teacherData: tData };

        // ── Mint Firebase Auth token ───────────────────────────────────────────
        try {
            const result = await mintTeacherToken({ schoolId: foundSchoolId, pin: code });
            await signInWithCustomToken(auth, result.data.token);
        } catch (e) {
            console.error('[Teacher Login] mintTeacherToken failed:', e);
            msgEl.textContent = 'Authentication service unavailable. Please try again.';
            msgEl.classList.remove('hidden');
            resetLoginBtn(btn);
            return;
        }

        // ── Check if PIN reset is required ────────────────────────────────────
        if (tData.requiresPinReset) {
            resetLoginBtn(btn);
            const forceModal = document.getElementById('forceResetModal');
            if (forceModal) {
                forceModal.classList.add('open');
                forceModal.style.opacity      = '1';
                forceModal.style.pointerEvents = 'all';
            }
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
        if (isGlobalTeacher) {
            await updateDoc(doc(db, 'teachers', tempSession.teacherId), {
                pin: n, requiresPinReset: false
            });
        } else {
            await updateDoc(doc(db, 'schools', tempSession.schoolId, 'teachers', tempSession.teacherId), {
                loginCode: n, requiresPinReset: false
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

    const forceModal = document.getElementById('forceResetModal');
    if (forceModal) {
        forceModal.classList.remove('open');
        forceModal.style.opacity      = '0';
        forceModal.style.pointerEvents = 'none';
    }
    closeOverlay('forceResetModal', 'forceResetModalInner');

    btn.innerHTML = `Save & Continue <i class="fa-solid fa-arrow-right"></i>`;
    btn.disabled  = false;

    setTimeout(async () => { await finalizeLogin(); }, 350);
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
