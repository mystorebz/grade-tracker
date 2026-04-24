/**
 * ConnectUs — Auth Module
 *
 * KEY CHANGES FROM ORIGINAL:
 *  1. sessionStorage → localStorage
 *     sessionStorage is tab-local: a new tab, Ctrl+click, or browser restart wipes
 *     it, triggering a login redirect. localStorage persists across tabs and restarts.
 *
 *  2. window.location.replace() instead of .href for redirects
 *     replace() removes the current page from history so the back button doesn't
 *     loop the user back to a protected page after logout or an auth failure.
 *
 *  3. Page fade-in on requireAuth()
 *     Every protected HTML page starts with `html { opacity: 0 }`.
 *     requireAuth() schedules a smooth fade-in after auth passes.
 *     If auth fails the page stays invisible while the redirect fires — no flash.
 *
 *  4. Session integrity check
 *     Validates that stored session has the minimum required fields before
 *     treating it as authenticated. Corrupt/incomplete data = re-login.
 *
 *  All exported function signatures are IDENTICAL to the original —
 *  zero changes needed in any page script that already calls these.
 */

// ── PRIVATE HELPERS ───────────────────────────────────────────────────────────

const SESSION_KEY = (role) => `connectus_${role}_session`;

/**
 * Validates a parsed session object has the minimum required shape.
 * Prevents corrupt localStorage data from being treated as authenticated.
 */
function isValidSession(role, data) {
    if (!data || typeof data !== 'object') return false;
    if (role === 'teacher') return !!(data.schoolId && data.teacherId && data.teacherData);
    if (role === 'admin')   return !!(data.schoolId && data.adminId);
    if (role === 'student') return !!(data.schoolId && data.studentId);
    return !!data; // unknown role — just check it exists
}

/**
 * Triggers a smooth fade-in of the page after the layout has been injected.
 * Uses two nested rAF calls to guarantee we're past the current paint frame
 * AND the layout injection synchronous work before starting the transition.
 */
function fadePageIn() {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            document.documentElement.style.transition = 'opacity 0.2s ease';
            document.documentElement.style.opacity   = '1';
        });
    });
}

// ── PUBLIC API — signatures match original exactly ────────────────────────────

/**
 * Saves the user's login session to localStorage so it survives
 * page loads, new tabs, and browser restarts.
 *
 * @param {string} role - 'teacher' | 'admin' | 'student'
 * @param {object} data - The session payload from the login flow
 */
export function setSessionData(role, data) {
    try {
        localStorage.setItem(SESSION_KEY(role), JSON.stringify(data));
    } catch (e) {
        // Storage quota exceeded or private-mode restriction
        console.error('[ConnectUs] Could not write session to localStorage:', e);
    }
}

/**
 * Retrieves and parses the session from localStorage.
 *
 * @param {string} role - 'teacher' | 'admin' | 'student'
 * @returns {object|null} Parsed session object, or null if not found / unreadable
 */
export function getSessionData(role) {
    try {
        const raw = localStorage.getItem(SESSION_KEY(role));
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        // Corrupt JSON in storage — clear it so we don't loop
        console.error('[ConnectUs] Corrupt session data, clearing:', e);
        localStorage.removeItem(SESSION_KEY(role));
        return null;
    }
}

/**
 * Security guard for every protected page.
 * Call this at the top of each page's JS module — before any other work.
 *
 * On success: returns the session object and schedules a smooth page fade-in.
 * On failure: immediately redirects (using replace so back-button doesn't loop)
 *             and returns null.
 *
 * @param {string} role        - 'teacher' | 'admin' | 'student'
 * @param {string} redirectUrl - Login page path relative to the calling page
 * @returns {object|null}      - Session data if authenticated, null if not
 */
export function requireAuth(role, redirectUrl = '../index.html') {
    const session = getSessionData(role);

    if (!session || !isValidSession(role, session)) {
        console.warn(`[ConnectUs] No valid ${role} session — redirecting to ${redirectUrl}`);
        // Replace so the protected page is not in history
        window.location.replace(redirectUrl);
        return null;
    }

    // Auth passed — trigger the page fade-in after layout injection runs
    fadePageIn();
    return session;
}

/**
 * Clears ALL ConnectUs session data and sends the user to the login page.
 * Uses replace() so they can't navigate back to the protected page.
 *
 * @param {string} redirectUrl - Login page path relative to the calling page
 */
export function logout(redirectUrl = '../index.html') {
    // Clear only ConnectUs keys rather than wiping all of localStorage,
    // in case the site shares storage with other tools.
    ['teacher', 'admin', 'student'].forEach(role => {
        localStorage.removeItem(SESSION_KEY(role));
    });
    // Also clear any runtime caches stored under the connectUs_ namespace
    Object.keys(localStorage)
        .filter(k => k.startsWith('connectUs_') || k.startsWith('connectus_'))
        .forEach(k => localStorage.removeItem(k));

    window.location.replace(redirectUrl);
}
