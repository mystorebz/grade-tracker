import { auth, db } from './firebase-init.js';
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { signOut, onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const SESSION_KEY = (role) => `connectus_${role}_session`;

function isValidSession(role, data) {
    if (!data || typeof data !== 'object') return false;
    if (role === 'teacher') return !!(data.schoolId && data.teacherId && data.teacherData);
    if (role === 'admin')   return !!(data.schoolId && data.adminId);
    if (role === 'student') return !!(data.schoolId && data.studentId);
    return !!data;
}

export function setSessionData(role, data) {
    try {
        localStorage.setItem(SESSION_KEY(role), JSON.stringify(data));
    } catch (e) {
        console.error('[ConnectUs] Could not write session to localStorage:', e);
    }
}

export function getSessionData(role) {
    try {
        const raw = localStorage.getItem(SESSION_KEY(role));
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.error('[ConnectUs] Corrupt session data, clearing:', e);
        localStorage.removeItem(SESSION_KEY(role));
        return null;
    }
}

export function requireAuth(role, redirectUrl = '../index.html') {
    const session = getSessionData(role);
    if (!session || !isValidSession(role, session)) {
        console.warn(`[ConnectUs] No valid ${role} session — redirecting to ${redirectUrl}`);
        window.location.replace(redirectUrl);
        return null;
    }

    // ── 1. FIREBASE AUTH EXPIRE CHECK ─────────────────────────────────────────
    if (auth.currentUser === null) {
        onAuthStateChanged(auth, (user) => {
            if (!user) {
                console.warn(`[ConnectUs] Firebase Auth session expired for ${role}`);
                logout(redirectUrl);
            }
        });
    }

    // ── 1b. AUTH IDENTITY DRIFT CHECK (session-bleed guard) ───────────────────
    // getAuth(app) in firebase-init.js uses Firebase's default
    // browserLocalPersistence, which is shared across every tab open at the
    // SAME ORIGIN — there is exactly one live Firebase Auth identity per
    // browser profile per origin, not one per tab. localStorage's
    // connectus_{role}_session blob, by contrast, is written once at login
    // and never re-validated against the live Auth session afterward.
    //
    // Concretely: a teacher signs in in Tab A (mints a teacher custom token,
    // real Firebase Auth identity = teacher). A student then signs in in
    // Tab B, at the same origin — this silently REPLACES the shared Auth
    // identity out from under Tab A, whose UI still renders "teacher" from
    // its untouched localStorage blob and whose Firestore writes then start
    // getting rejected (Firestore correctly sees a caller whose real token
    // claims say student, not teacher) — with no error surfaced anywhere
    // except a generic "Missing or insufficient permissions" deep in
    // whatever the teacher happened to click.
    //
    // This check catches that drift as soon as a real ID token is available
    // (not just "some user is signed in", which the block above already
    // checks) by confirming the live token's OWN role claim — set server-
    // side by mintTeacherToken/mintStudentToken/mintAdminToken, never
    // client-writable — actually matches the role this page requires. A
    // mismatch means the localStorage session is stale relative to the
    // browser's real Auth identity: continuing to render this page would
    // just accumulate more silently-failing writes, so it force-signs-out
    // and sends the user back to the right login instead.
    if (auth.currentUser) {
        auth.currentUser.getIdTokenResult(false)
            .then((tokenResult) => {
                const tokenRole = tokenResult.claims?.role;
                if (tokenRole && tokenRole !== role) {
                    console.warn(`[ConnectUs] Auth identity drift detected: page requires '${role}' but the live Firebase Auth session is '${tokenRole}'. This browser profile is signed in as a different role in another tab. Forcing re-authentication.`);
                    logout(redirectUrl);
                }
            })
            .catch((e) => {
                console.error('[ConnectUs] Auth identity drift check failed:', e);
            });
    }

    // ── 2. THE GHOSTBUSTER: REAL-TIME DATABASE KILL SWITCH ────────────────────
    // This listens to the school's document. If deleted or suspended, kicks them out.
    if (session.schoolId) {
        const schoolRef = doc(db, 'schools', session.schoolId);

        onSnapshot(schoolRef, (docSnap) => {
            if (!docSnap.exists()) {
                console.warn(`[ConnectUs Ghostbuster] School deleted. Evicting.`);
                logout(redirectUrl);
            } else if (docSnap.data().isVerified !== true) {
                console.warn(`[ConnectUs Ghostbuster] School suspended. Evicting.`);
                // Super admin sees their school summary on the suspended page.
                // Session must be preserved so the page can load school stats.
                if (role === 'admin' && session.isSuperAdmin) {
                    window.location.replace('../deactivated/deactivated.html');
                } else {
                    logout(redirectUrl);
                }
            }
        }, (error) => {
            console.error(`[ConnectUs Ghostbuster] Security/Permission error:`, error);
            logout(redirectUrl);
        });
    }

    // ── 3. STUDENT ENROLLMENT WATCHER ─────────────────────────────────────────
    // Detects mid-session status changes — archived, transferred, or restored.
    if (role === 'student' && session.studentId) {
        const studentRef = doc(db, 'students', session.studentId);
        onSnapshot(studentRef, async (snap) => {
            if (!snap.exists()) { await logout(redirectUrl); return; }
            const data     = snap.data();
            const status   = data.enrollmentStatus || 'Active';
            const schoolId = data.currentSchoolId  || '';
            const path     = window.location.pathname;

            // Keep the cached session's studentData in sync with live
            // Firestore data. Without this, fields like classId/teacherId/
            // className only ever reflected what existed at login time —
            // e.g. a student assigned to a class mid-session would see
            // "no teacher assigned" on Class Stream until they logged out
            // and back in, even though the enrollment was already correct
            // server-side. This does not by itself re-render a page that
            // already read session.studentData before this fires; pages
            // that need to react live should re-read getSessionData().
            setSessionData('student', { ...session, studentData: data });

            if (status === 'Active') {
                // Restored mid-session — send back to dashboard if on inactive page
                if (path.includes('/inactive/')) window.location.replace('../home/home.html');
                return;
            }
            if (schoolId) {
                // Internally archived — redirect to inactive if not already there
                if (!path.includes('/inactive/')) window.location.replace('../inactive/inactive.html');
            } else {
                // Released — clear session and redirect to released screen
                if (!path.includes('/released/')) await logout('../released/released.html');
            }
        }, (error) => {
            console.error('[ConnectUs] Student watcher error:', error);
        });
    }

    // ── 4. TEACHER ARCHIVE WATCHER ────────────────────────────────────────────
    // Detects if a teacher is archived mid-session by an admin.
    // Session is preserved (no logout) so the deactivated page can load their career summary.
    if (role === 'teacher' && session.teacherId) {
        const isGlobal   = /^T\d{2}-[A-Z0-9]{5}$/i.test(session.teacherId);
        const teacherRef = isGlobal
            ? doc(db, 'teachers', session.teacherId)
            : doc(db, 'schools', session.schoolId, 'teachers', session.teacherId);
        onSnapshot(teacherRef, (snap) => {
            if (!snap.exists() || snap.data().archived === true) {
                console.warn('[ConnectUs] Teacher archived mid-session. Evicting.');
                window.location.replace('../deactivated/deactivated.html');
            }
        }, (error) => {
            console.error('[ConnectUs] Teacher watcher error:', error);
        });
    }

    // ── 5. SUB-ADMIN ARCHIVE WATCHER ──────────────────────────────────────────
    // Detects if a sub-admin is archived mid-session by the super admin.
    // Session is preserved (no logout) so the deactivated page can show their name.
    if (role === 'admin' && session.adminId && !session.isSuperAdmin) {
        const adminRef = doc(db, 'schools', session.schoolId, 'admins', session.adminId);
        onSnapshot(adminRef, (snap) => {
            if (!snap.exists() || snap.data().isArchived === true) {
                console.warn('[ConnectUs] Sub-admin archived mid-session. Evicting.');
                window.location.replace('../deactivated/deactivated.html');
            }
        }, (error) => {
            console.error('[ConnectUs] Admin watcher error:', error);
        });
    }

    return session;
}

export async function logout(redirectUrl = '../index.html') {
    // Sign out of Firebase Auth
    try {
        await signOut(auth);
    } catch (e) {
        console.error('[ConnectUs] Firebase signOut error:', e);
    }
    // Clear all ConnectUs localStorage keys
    ['teacher', 'admin', 'student'].forEach(role => {
        localStorage.removeItem(SESSION_KEY(role));
    });
    Object.keys(localStorage)
        .filter(k => k.startsWith('connectUs_') || k.startsWith('connectus_'))
        .forEach(k => localStorage.removeItem(k));
    window.location.replace(redirectUrl);
}
