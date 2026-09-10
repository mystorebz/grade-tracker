import { db, auth } from '../../assets/js/firebase-init.js';
import { doc, getDoc }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { signInWithCustomToken, signOut }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFunctions, httpsCallable }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";

// ── Functions instance ────────────────────────────────────────────────────────
const functions   = getFunctions();
const mintHQToken = httpsCallable(functions, 'mintHQToken');

// ── Elements ──────────────────────────────────────────────────────────────────
const authBtn  = document.getElementById('authBtn');
const errorMsg = document.getElementById('loginErrorMsg');

// ── Helpers ───────────────────────────────────────────────────────────────────
function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.add('show');
}

function hideError() {
    errorMsg.classList.remove('show');
}

function resetBtn() {
    authBtn.disabled  = false;
    authBtn.innerHTML = `<i class="fa-solid fa-shield-halved"></i> Authenticate`;
}

// ── Clear any stale Firebase Auth session on page load ────────────────────────
// If the user lands here, they should start with a clean auth state. This
// prevents leftover credentials from a previous (failed) attempt poisoning
// the next sign-in attempt.
(async () => {
    try { await signOut(auth); } catch (_) { /* ignore */ }
})();

// ── Keyboard support ──────────────────────────────────────────────────────────
['loginId', 'loginPin'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => {
        if (e.key === 'Enter') authBtn.click();
    });
});

// ── Auto-uppercase the ID field ───────────────────────────────────────────────
document.getElementById('loginId')?.addEventListener('input', e => {
    const pos = e.target.selectionStart;
    e.target.value = e.target.value.toUpperCase();
    e.target.setSelectionRange(pos, pos);
});

// ── Login Handler ─────────────────────────────────────────────────────────────
authBtn.addEventListener('click', async () => {
    const hqId = document.getElementById('loginId').value.trim().toUpperCase();
    const pin  = document.getElementById('loginPin').value;

    hideError();

    if (!hqId || !pin) {
        showError('Authorization ID and PIN are required.');
        return;
    }

    if (!hqId.startsWith('HQ-')) {
        showError('Invalid Authorization ID format.');
        return;
    }

    authBtn.disabled  = true;
    authBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Authenticating...`;

    try {
        // 1. Server-side PIN verification + Firebase token minting
        const result = await mintHQToken({ hqId, pin });

        // 2. Sign in with the custom token
        const userCredential = await signInWithCustomToken(auth, result.data.token);

        // 3. CRITICAL: force a token refresh and WAIT for the custom claims
        //    (role: 'platform_admin') to propagate to the Firestore SDK.
        //    Without this, the very next getDoc() may fire before Firestore
        //    sees the new claims and the rule check fails with permission-denied.
        const idTokenResult = await userCredential.user.getIdTokenResult(true);

        // 4. Defensive check: confirm the claim is actually present
        if (idTokenResult.claims.role !== 'platform_admin') {
            await signOut(auth);
            showError('Authentication failed. Invalid credentials.');
            resetBtn();
            return;
        }

        // 5. Fetch admin data for session (auth + claims confirmed)
        const docSnap = await getDoc(doc(db, 'platform_admins', hqId));

        if (!docSnap.exists()) {
            await signOut(auth);
            showError('Authentication failed. Invalid credentials.');
            resetBtn();
            return;
        }

        const adminData = docSnap.data();

        // 6. Save HQ session
        localStorage.setItem('connectus_hq_session', JSON.stringify({
            id:        docSnap.id,
            name:      adminData.name  || '',
            role:      adminData.role  || 'admin',
            timestamp: new Date().getTime()
        }));

        // 7. Redirect to dashboard. The browser is at /platform_dashboard/hq-login.html,
        //    so 'index.html' resolves to /platform_dashboard/index.html (the dashboard).
        window.location.replace('index.html');

    } catch (e) {
        console.error('[HQ Login]', e);

        // Make sure we don't leave a half-signed-in state behind
        try { await signOut(auth); } catch (_) { /* ignore */ }

        if (e.code === 'functions/unauthenticated' || e.code === 'functions/not-found') {
            showError('Authentication failed. Invalid credentials.');
        } else if (e.code === 'functions/permission-denied') {
            showError('Your access has been suspended. Contact your system administrator.');
        } else if (e.code === 'functions/invalid-argument') {
            showError('Invalid Authorization ID format.');
        } else {
            showError('A secure connection could not be established. Please try again.');
        }

        resetBtn();
    }
});
