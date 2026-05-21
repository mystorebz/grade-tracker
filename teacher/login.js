import { db, auth } from '../assets/js/firebase-init.js';
import { doc, getDoc, updateDoc }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { signInWithCustomToken, signOut }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFunctions, httpsCallable }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { setSessionData } from '../assets/js/auth.js';

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
    const pin   = document.getElementById('loginTeacherCode').value.trim();
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
        let claims;
        try {
            const authResult     = await mintTeacherToken({ schoolId: rawId, pin });
            const userCredential = await signInWithCustomToken(auth, authResult.data.token);
            const idTokenResult  = await userCredential.user.getIdTokenResult(true);
            claims               = idTokenResult.claims;
        } catch (authError) {
            console.error('[Teacher Login] Server rejected credentials:', authError);
            msgEl.textContent = 'Invalid School ID or Teacher Code.';
            msgEl.classList.remove('hidden');
            resetLoginBtn(btn);
            return;
        }

        // ── 2. SERVER VERIFIED — read from signed token claims ────────────────
        const teacherId = claims.teacherId;
        const schoolId  = claims.schoolId;
        isGlobalTeacher = !claims.legacy;

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

        // ── CHANGE: set session before redirecting so the deactivated page
        //            can load the teacher's career summary without a loop ────────
        if (tData.archived) {
            setSessionData('teacher', { schoolId, teacherId, teacherData: tData });
            window.location.replace('deactivated/deactivated.html');
            return;
        }

        const schoolSnap = await getDoc(doc(db, 'schools', schoolId));
        schoolType  = schoolSnap.data()?.schoolType || 'Primary';
        tempSession = { schoolId, teacherId, teacherData: tData };

        await finalizeLogin();

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

// ── 2. FINALIZE LOGIN (Routing) ───────────────────────────────────────────────
async function finalizeLogin() {
    try {
        const currentClasses = tempSession.teacherData.classes || [];
        localStorage.setItem('connectus_cached_classes', JSON.stringify(currentClasses));

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

    if (isGlobalTeacher && tempSession.teacherData.profileComplete === false) {
        window.location.href = 'onboarding/onboarding.html';
        return;
    }

    if (isGlobalTeacher && !tempSession.teacherData.securityQuestionsSet) {
        window.location.href = '../onboarding/first-time-setup.html?role=teacher';
        return;
    }

    window.location.href = 'home/home.html';
}
