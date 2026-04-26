import { auth } from './firebase-init.js';
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

    // If Firebase Auth session has expired, clear and redirect.
    // We check this non-blocking — page loads normally from localStorage,
    // but if Firebase says the token is gone we log them out on next load.
    if (auth.currentUser === null) {
        onAuthStateChanged(auth, (user) => {
            if (!user) {
                console.warn(`[ConnectUs] Firebase Auth session expired for ${role}`);
                logout(redirectUrl);
            }
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
