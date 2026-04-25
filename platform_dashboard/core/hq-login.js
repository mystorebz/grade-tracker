import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const authBtn  = document.getElementById('authBtn');
const errorMsg = document.getElementById('loginErrorMsg');

// ── SHA-256 Hash ──────────────────────────────────────────────────────────────
async function sha256(text) {
    const encoded     = new TextEncoder().encode(text.trim());
    const hashBuffer  = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.remove('hidden');
}

authBtn.addEventListener('click', async () => {
    const hqId = document.getElementById('loginId').value.trim().toUpperCase();
    const pin  = document.getElementById('loginPin').value;

    errorMsg.classList.add('hidden');

    if (!hqId || !pin) {
        showError("Authorization ID and PIN are required."); return;
    }

    if (!hqId.startsWith('HQ-')) {
        showError("Invalid Authorization ID format."); return;
    }

    authBtn.disabled = true;
    authBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Authenticating...';

    try {
        const hashedPin = await sha256(pin);
        const docSnap   = await getDoc(doc(db, 'platform_admins', hqId));

        if (!docSnap.exists() || docSnap.data().pin !== hashedPin) {
            showError("Authentication failed. Invalid credentials.");
            authBtn.disabled = false;
            authBtn.innerHTML = 'Authenticate →';
            return;
        }

        const adminData = docSnap.data();

        if (!adminData.isActive) {
            showError("Your access has been suspended.");
            authBtn.disabled = false;
            authBtn.innerHTML = 'Authenticate →';
            return;
        }

        // Establish HQ Session in LocalStorage
        const sessionData = {
            id: docSnap.id,
            name: adminData.name,
            role: adminData.role,
            timestamp: new Date().getTime()
        };
        
        // We will store this specifically for the HQ dashboard
        localStorage.setItem('connectus_hq_session', JSON.stringify(sessionData));

        // Redirect to the HQ Dashboard (which we will build next)
        window.location.replace('index.html');

    } catch (error) {
        console.error("Login Error:", error);
        showError("A secure connection could not be established.");
        authBtn.disabled = false;
        authBtn.innerHTML = 'Authenticate →';
    }
});
