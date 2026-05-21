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
