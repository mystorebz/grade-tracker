// ── SESSION MANAGEMENT ──────────────────────────────────────────

/**
 * Saves the user's login session to the browser's memory so it survives page loads.
 * @param {string} role - 'teacher', 'admin', or 'student'
 * @param {object} data - The session data (e.g., {schoolId, teacherId, teacherData})
 */
export function setSessionData(role, data) {
    sessionStorage.setItem(`connectus_${role}_session`, JSON.stringify(data));
}

/**
 * Retrieves the session data from the browser.
 * @param {string} role - 'teacher', 'admin', or 'student'
 * @returns {object|null} The session data, or null if not logged in.
 */
export function getSessionData(role) {
    const data = sessionStorage.getItem(`connectus_${role}_session`);
    return data ? JSON.parse(data) : null;
}

/**
 * Acts as the security bouncer for protected pages.
 * Put this at the top of every protected page's JavaScript file.
 * @param {string} role - 'teacher', 'admin', or 'student'
 * @param {string} redirectUrl - Where to send them if they aren't logged in
 * @returns {object} The session data if authenticated.
 */
export function requireAuth(role, redirectUrl = '../index.html') {
    const session = getSessionData(role);
    if (!session) {
        console.warn(`Unauthorized access. Redirecting to ${redirectUrl}`);
        window.location.href = redirectUrl;
        return null;
    }
    return session;
}

/**
 * Clears the session and sends the user back to the login page.
 */
export function logout(redirectUrl = '../index.html') {
    sessionStorage.clear(); // Wipes all saved session data
    window.location.href = redirectUrl;
}
