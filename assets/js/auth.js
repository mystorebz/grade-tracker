import { auth, db } from './firebase-init.js'; // Make sure db is imported
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"; // Import Firestore functions
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
                logout(redirectUrl);
            }
        }, (error) => {
            console.error(`[ConnectUs Ghostbuster] Security/Permission error:`, error);
            logout(redirectUrl); // Kick them out if rules suddenly block access
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
