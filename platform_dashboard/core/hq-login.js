import { db, auth } from '../../assets/js/firebase-init.js';
import { doc, getDoc }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { signInWithCustomToken }
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
        // Server-side PIN verification + Firebase token minting
        const result = await mintHQToken({ hqId, pin });
        await signInWithCustomToken(auth, result.data.token);

        // Fetch admin data for session (auth confirmed at this point)
        const docSnap = await getDoc(doc(db, 'platform_admins', hqId));

        if (!docSnap.exists()) {
            showError('Authentication failed. Invalid credentials.');
            resetBtn();
            return;
        }

        const adminData = docSnap.data();

        // Save HQ session
        localStorage.setItem('connectus_hq_session', JSON.stringify({
            id:        docSnap.id,
            name:      adminData.name  || '',
            role:      adminData.role  || 'admin',
            timestamp: new Date().getTime()
        }));

        window.location.replace('index.html');

    } catch (e) {
        console.error('[HQ Login]', e);

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
