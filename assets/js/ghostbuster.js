import { db, auth } from './firebase-init.js';
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getSessionData, clearSessionData } from './auth.js';

// ── The Ghostbuster Boot Sequence ─────────────────────────────────────────────
export function initGhostbuster(role) {
    // 1. Grab the current session from Local Storage
    const session = getSessionData(role);

    // 2. If there is no session, they shouldn't be here anyway. Kick them.
    if (!session || !session.schoolId) {
        evictUser("No valid session found.");
        return;
    }

    // 3. Attach a Real-Time Listener to their School Document
    const schoolRef = doc(db, 'schools', session.schoolId);

    // onSnapshot listens continuously. If the backend changes, this fires instantly.
    const unsubscribe = onSnapshot(schoolRef, (docSnap) => {
        // Condition A: The document was deleted
        if (!docSnap.exists()) {
            evictUser("School account has been deleted.");
            unsubscribe(); // Stop listening
            return;
        }

        // Condition B: The school was suspended (isVerified flipped to false)
        const schoolData = docSnap.data();
        if (schoolData.isVerified !== true) {
            evictUser("School account is suspended or pending verification.");
            unsubscribe(); // Stop listening
            return;
        }

        // Condition C: Sub-Admin checks (Optional, if you want to kick specific admins)
        // If the user is a sub_admin, you could also nest a listener here 
        // for doc(db, 'schools', session.schoolId, 'admins', session.adminId)
    }, 
    (error) => {
        // Condition D: Firestore Rules blocked them (Permission Denied)
        console.error("Ghostbuster Security Error:", error);
        evictUser("Database access revoked.");
    });
}

// ── The Eviction Function ─────────────────────────────────────────────────────
async function evictUser(reason) {
    console.warn(`[Ghostbuster] Evicting user: ${reason}`);
    
    try {
        // 1. Sign out of Firebase Auth to kill the backend token
        await signOut(auth);
    } catch (e) {
        console.error("Auth signout failed, but clearing storage anyway.", e);
    }

    // 2. Wipe the local storage so they can't pretend to be logged in
    clearSessionData('admin'); // adjust this depending on your auth.js logic
    localStorage.clear(); // Nuclear option: clear everything

    // 3. Kick them back to the login page
    // Adjust the path depending on where your login HTML is relative to the dashboard
    window.location.replace('../index.html'); 
}
