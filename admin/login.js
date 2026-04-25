import { db } from '../assets/js/firebase-init.js';
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { setSessionData } from '../assets/js/auth.js';

// Elements
const loginBtn        = document.getElementById('loginBtn');
const loginMsg        = document.getElementById('loginMsg');
const forceResetModal = document.getElementById('forceResetModal');
const saveForceCodeBtn = document.getElementById('saveForceCodeBtn');
const forceResetMsg   = document.getElementById('forceResetMsg');

// State
let tempSchoolId   = null;
let tempSchoolData = null;

// ── SHA-256 Hash ───────────────────────────────────────────────────────────
// Same normalization (lowercase + trim) used across all ConnectUs auth flows.
async function sha256(text) {
    const normalized  = text.toLowerCase().trim();
    const encoded     = new TextEncoder().encode(normalized);
    const hashBuffer  = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// ── DYNAMIC LIMITS FETCHING ────────────────────────────────────────────────
async function fetchPlanDetails(planId) {
    try {
        const planSnap = await getDoc(doc(db, 'subscriptionPlans', planId || 'starter'));
        if (planSnap.exists()) {
            return { limit: planSnap.data().limit, name: planSnap.data().name };
        }
    } catch (e) {
        console.error("Error fetching plan details:", e);
    }
    return { limit: 50, name: 'Starter Plan' };
}

// ── LAUNCH DASHBOARD ───────────────────────────────────────────────────────
// Sets session data first, then runs gate checks before final redirect.
function launchDashboard(schoolId, data) {
    // Session must be set BEFORE any gate redirect so first-time-setup
    // can read it via requireAuth on the other side.
    setSessionData('admin', {
        schoolId,
        adminId:          schoolId,
        schoolName:       data.schoolName,
        contactEmail:     data.contactEmail    || '',
        logoUrl:          data.logoUrl         || '',
        activeSemesterId: data.activeSemesterId || '',
        schoolType:       data.schoolType      || 'Primary',
        planLimit:        data.planLimit,
        planName:         data.planName
    });

    // Gate: security questions not set (legacy admins initialized before
    // the security questions feature was added, or any edge case).
    // New admins have securityQuestionsSet: true written by onboarding.js.
    if (!data.securityQuestionsSet) {
        window.location.href = '../onboarding/first-time-setup.html?role=admin';
        return;
    }

    window.location.href = './home/home.html';
}

// ── LOGIN HANDLER ──────────────────────────────────────────────────────────
loginBtn.addEventListener('click', async () => {
    const rawId  = document.getElementById('loginSchoolId').value.trim();
    const codeIn = document.getElementById('loginAdminCode').value.trim();

    loginMsg.classList.add('hidden');

    if (!rawId || !codeIn) {
        loginMsg.textContent = 'Please enter both fields.';
        loginMsg.classList.remove('hidden');
        return;
    }

    loginBtn.disabled = true;
    loginBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Authenticating...`;

    try {
        let snap;
        for (const id of [rawId.toUpperCase(), rawId.toLowerCase(), rawId]) {
            snap = await getDoc(doc(db, 'schools', id));
            if (snap.exists()) break;
        }

        if (!snap || !snap.exists()) {
            loginMsg.textContent = 'School ID not found.';
            loginMsg.classList.remove('hidden');
        } else {
            const data = snap.data();

            if (data.isVerified !== true) {
                loginMsg.textContent = 'Account pending approval. Contact ConnectUs.';
                loginMsg.classList.remove('hidden');
            } else {
                // ── Hash-aware comparison ──────────────────────────────────
                // New accounts (post-update onboarding.js): adminCode is SHA-256 hash.
                // Legacy accounts: adminCode is plain text — auto-upgrade on match
                // so the account silently migrates without requiring user action.
                const hashedInput = await sha256(codeIn);
                let authSuccess   = false;

                if (hashedInput === data.adminCode) {
                    // New hashed flow — standard path
                    authSuccess = true;

                } else if (codeIn === (data.adminCode || 'ADMIN2024')) {
                    // Legacy plain-text match — auto-upgrade to hashed
                    authSuccess = true;
                    await updateDoc(doc(db, 'schools', snap.id), { adminCode: hashedInput });
                    data.adminCode = hashedInput;
                }

                if (!authSuccess) {
                    loginMsg.textContent = 'Incorrect Admin Code.';
                    loginMsg.classList.remove('hidden');
                } else {
                    tempSchoolId   = snap.id;
                    tempSchoolData = data;

                    const planDetails = await fetchPlanDetails(data.subscriptionPlan);
                    tempSchoolData.planLimit = planDetails.limit;
                    tempSchoolData.planName  = planDetails.name;

                    if (data.requiresPinReset) {
                        forceResetModal.classList.remove('hidden');
                        requestAnimationFrame(() => forceResetModal.classList.remove('opacity-0'));
                    } else {
                        launchDashboard(tempSchoolId, tempSchoolData);
                    }
                }
            }
        }
    } catch (e) {
        console.error(e);
        loginMsg.textContent = 'Connection error. Please try again.';
        loginMsg.classList.remove('hidden');
    }

    loginBtn.disabled = false;
    loginBtn.innerHTML = `<i class="fa-solid fa-arrow-right-to-bracket"></i> Secure Login`;
});

// ── FORCE RESET HANDLER ────────────────────────────────────────────────────
// Hashes the new code before saving — consistent with onboarding.js.
saveForceCodeBtn.addEventListener('click', async () => {
    const n = document.getElementById('newForceCode').value.trim();
    const c = document.getElementById('confirmForceCode').value.trim();

    forceResetMsg.classList.add('hidden');

    if (!n || !c) { forceResetMsg.textContent = 'Fill both fields.';    forceResetMsg.classList.remove('hidden'); return; }
    if (n !== c)  { forceResetMsg.textContent = 'Codes do not match.'; forceResetMsg.classList.remove('hidden'); return; }
    if (n.length < 5) { forceResetMsg.textContent = 'Min. 5 characters.'; forceResetMsg.classList.remove('hidden'); return; }

    saveForceCodeBtn.disabled = true;
    saveForceCodeBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Updating...`;

    try {
        const hashedNew = await sha256(n);

        await updateDoc(doc(db, 'schools', tempSchoolId), {
            adminCode:        hashedNew,   // Store as hash
            requiresPinReset: false
        });

        tempSchoolData.adminCode        = hashedNew;
        tempSchoolData.requiresPinReset = false;

        forceResetModal.classList.add('opacity-0');
        setTimeout(() => {
            forceResetModal.classList.add('hidden');
            launchDashboard(tempSchoolId, tempSchoolData);
        }, 300);

    } catch (error) {
        console.error("Force reset update error:", error);
        forceResetMsg.textContent = 'An error occurred. Please try again.';
        forceResetMsg.classList.remove('hidden');
        saveForceCodeBtn.disabled = false;
        saveForceCodeBtn.innerHTML = `Save & Continue <i class="fa-solid fa-arrow-right"></i>`;
    }
});
