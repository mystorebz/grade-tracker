import { db } from '../assets/js/firebase-init.js';
import { collection, query, where, getDocs, doc, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// DOM
const loadingState  = document.getElementById('loadingState');
const setupForm     = document.getElementById('setupForm');
const lockoutScreen = document.getElementById('lockoutScreen');
const successScreen = document.getElementById('successScreen');
const errorMsg      = document.getElementById('setupErrorMsg');
const initializeBtn = document.getElementById('initializeBtn');

// ── SHA-256 Hash ──────────────────────────────────────────────────────────────
async function sha256(text) {
    const encoded     = new TextEncoder().encode(text.trim());
    const hashBuffer  = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Generate HQ ID (e.g., HQ-8B2X9) ───────────────────────────────────────────
function generateHqId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rand = '';
    for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return `HQ-${rand}`;
}

// ── Boot Sequence: Security Lockout Check ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    try {
        // Check if an Owner already exists in the platform_admins collection
        const q = query(collection(db, 'platform_admins'), where('role', '==', 'Owner'));
        const snap = await getDocs(q);

        loadingState.classList.add('hidden');

        if (!snap.empty) {
            // Lock it down.
            lockoutScreen.classList.remove('hidden');
        } else {
            // Safe to proceed.
            setupForm.classList.remove('hidden');
        }
    } catch (error) {
        console.error("Lockout Check Failed:", error);
        loadingState.innerHTML = `<p class="text-red-500 font-bold">Database connection error. Check your Firebase Rules.</p>`;
    }
});

// ── Initialize HQ ─────────────────────────────────────────────────────────────
initializeBtn.addEventListener('click', async () => {
    const name    = document.getElementById('hqName').value.trim();
    const email   = document.getElementById('hqEmail').value.trim().toLowerCase();
    const pin     = document.getElementById('hqPin').value;
    const confirm = document.getElementById('hqPinConfirm').value;

    errorMsg.classList.add('hidden');

    if (!name || !email || !pin) {
        showError("All fields are required."); return;
    }
    if (pin !== confirm) {
        showError("PINs do not match."); return;
    }
    if (pin.length < 6) {
        showError("PIN must be at least 6 characters."); return;
    }

    initializeBtn.disabled = true;
    initializeBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Securing Node...';

    try {
        const hashedPin = await sha256(pin);
        const newHqId   = generateHqId();

        // Write the Master Owner document
        await setDoc(doc(db, 'platform_admins', newHqId), {
            name: name,
            email: email,
            pin: hashedPin,
            role: 'Owner', // The highest permission level
            isActive: true,
            createdAt: new Date().toISOString()
        });

        // Show Success
        setupForm.classList.add('hidden');
        successScreen.classList.remove('hidden');
        document.getElementById('finalHqId').textContent = newHqId;

    } catch (error) {
        console.error("Creation Failed:", error);
        showError("Failed to initialize HQ. Check console.");
        initializeBtn.disabled = false;
        initializeBtn.innerHTML = 'Initialize HQ & Lock Protocol →';
    }
});

function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.remove('hidden');
}
