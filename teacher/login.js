import { db, auth } from '../assets/js/firebase-init.js';
import { collection, query, where, getDocs, getDoc, doc, updateDoc }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { signInWithCustomToken }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFunctions, httpsCallable }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { setSessionData } from '../assets/js/auth.js';
import { openOverlay, closeOverlay } from '../assets/js/utils.js';

// ── Functions instance ────────────────────────────────────────────────────────
const functions        = getFunctions();
const mintTeacherToken = httpsCallable(functions, 'mintTeacherToken');

// ── State & Constants ─────────────────────────────────────────────────────────
let tempSession     = { schoolId: null, teacherId: null, teacherData: null };
let schoolType      = 'Primary';
let isGlobalTeacher = false;

const CLASSES = {
    'Primary':        ['Infant 1', 'Infant 2', 'Standard 1', 'Standard 2', 'Standard 3', 'Standard 4', 'Standard 5', 'Standard 6'],
    'High School':    ['First Form', 'Second Form', 'Third Form', 'Fourth Form'],
    'Junior College': ['Year 1', 'Year 2']
};

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
            } catch (e) { /* composite index may not exist yet */ }
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
                } catch (e) { continue; }
            }
        }

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

        // ── Mint Firebase Auth token FIRST — before any Firestore writes ──────
        // Rules now require request.auth != null for writes. Token must be
        // established before finalizeLogin() attempts any updateDoc calls.
        try {
            const result = await mintTeacherToken({ schoolId: foundSchoolId, pin: code });
            await signInWithCustomToken(auth, result.data.token);
        } catch (e) {
            console.error('[Teacher Login] mintTeacherToken failed:', e);
            msgEl.textContent = 'Authentication service unavailable. Please try again.';
            msgEl.classList.remove('hidden');
            resetLoginBtn(btn);
            return; // <-- FIX: Stops execution to prevent infinite spin and failed writes
        }

        // FIX: The line hiding the login-shell has been completely removed.

        const needsClasses = !tData.classes || tData.classes.length === 0;

        if (tData.requiresPinReset) {
            openOverlay('forceResetModal', 'forceResetModalInner');
        } else if (needsClasses) {
            triggerOnboarding();
        } else {
            await finalizeLogin();
        }

    } catch (e) {
        console.error('[Teacher Login]', e);
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

    if (!n || !c)     { msg.textContent = 'Fill both fields.';    msg.classList.remove('hidden'); return; }
    if (n !== c)      { msg.textContent = 'Codes do not match.';  msg.classList.remove('hidden'); return; }
    if (n.length < 5) { msg.textContent = 'Minimum 5 characters.'; msg.classList.remove('hidden'); return; }

    const btn = document.getElementById('saveForceCodeBtn');
    btn.disabled  = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;

    if (isGlobalTeacher) {
        await updateDoc(doc(db, 'teachers', tempSession.teacherId), {
            pin: n, requiresPinReset: false
        });
    } else {
        await updateDoc(doc(db, 'schools', tempSession.schoolId, 'teachers', tempSession.teacherId), {
            loginCode: n, requiresPinReset: false
        });
    }

    tempSession.teacherData.requiresPinReset = false;
    closeOverlay('forceResetModal', 'forceResetModalInner');

    setTimeout(async () => {
        const needsClasses = !tempSession.teacherData.classes || tempSession.teacherData.classes.length === 0;
        if (needsClasses) triggerOnboarding();
        else await finalizeLogin();
    }, 350);

    btn.innerHTML = `Save & Continue <i class="fa-solid fa-arrow-right"></i>`;
    btn.disabled  = false;
});

// ── 3. CLASS SELECTION ────────────────────────────────────────────────────────
function triggerOnboarding() {
    const classList = CLASSES[schoolType] || CLASSES['Primary'];
    document.getElementById('onboardSubtitle').textContent =
        `Select the class${classList.length > 1 ? '(es)' : ''} you teach at ${schoolType} level.`;

    document.getElementById('classGrid').innerHTML = classList.map(c => `
        <div class="cls-cb-item" id="wrap-${c.replace(/\s/g, '_')}"
             onclick="window.toggleClassCb('${c.replace(/\s/g, '_')}', '${c}')">
            <input type="checkbox" id="cb-${c.replace(/\s/g, '_')}" value="${c}">
            <label for="cb-${c.replace(/\s/g, '_')}" onclick="event.stopPropagation()">${c}</label>
        </div>`).join('');

    openOverlay('onboardModal', 'onboardModalInner');
}

window.toggleClassCb = function(safeId, className) {
    const cb   = document.getElementById('cb-' + safeId);
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
    btn.disabled  = true;

    const updateRef = isGlobalTeacher
        ? doc(db, 'teachers', tempSession.teacherId)
        : doc(db, 'schools', tempSession.schoolId, 'teachers', tempSession.teacherId);

    await updateDoc(updateRef, { classes: selected, className: selected[0] });

    tempSession.teacherData.classes   = selected;
    tempSession.teacherData.className = selected[0];

    closeOverlay('onboardModal', 'onboardModalInner');
    setTimeout(async () => await finalizeLogin(), 350);

    btn.innerHTML = `<i class="fa-solid fa-check mr-2"></i>Save & Enter Portal`;
    btn.disabled  = false;
});

// ── 4. FINALIZE LOGIN ─────────────────────────────────────────────────────────
async function finalizeLogin() {
    try {
        // ── Safety: ensure classes array ──────────────────────────────────────
        if (!tempSession.teacherData.classes || tempSession.teacherData.classes.length === 0) {
            const classes   = tempSession.teacherData.className ? [tempSession.teacherData.className] : [];
            const updateRef = isGlobalTeacher
                ? doc(db, 'teachers', tempSession.teacherId)
                : doc(db, 'schools', tempSession.schoolId, 'teachers', tempSession.teacherId);
            await updateDoc(updateRef, { classes });
            tempSession.teacherData.classes = classes;
        }

        localStorage.setItem('connectus_cached_classes', JSON.stringify(tempSession.teacherData.classes));

        // ── Safety: migrate legacy string subjects ────────────────────────────
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

        // ── Safety: default subjects if empty ────────────────────────────────
        if (!tempSession.teacherData.subjects || !tempSession.teacherData.subjects.length) {
            const updateRef = isGlobalTeacher
                ? doc(db, 'teachers', tempSession.teacherId)
                : doc(db, 'schools', tempSession.schoolId, 'teachers', tempSession.teacherId);
            await updateDoc(updateRef, { subjects: DEFAULT_SUBJECTS });
            tempSession.teacherData.subjects = DEFAULT_SUBJECTS;
        }

    } catch (e) {
        // Log but don't block — these are safety migrations, not critical path
        console.warn('[Teacher Login] finalizeLogin migration warning:', e.message);
    }

    // ── Save session ──────────────────────────────────────────────────────────
    setSessionData('teacher', tempSession);

    // ── Gate 1: Profile completion ────────────────────────────────────────────
    if (isGlobalTeacher && tempSession.teacherData.profileComplete === false) {
        window.location.href = 'onboarding/onboarding.html';
        return;
    }

    // ── Gate 2: Security questions ────────────────────────────────────────────
    if (isGlobalTeacher && !tempSession.teacherData.securityQuestionsSet) {
        window.location.href = '../onboarding/first-time-setup.html?role=teacher';
        return;
    }

    window.location.href = 'home/home.html';
}
