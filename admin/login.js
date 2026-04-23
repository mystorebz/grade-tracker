import { db } from '../assets/js/firebase-init.js';
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { setSessionData } from '../assets/js/auth.js';

// Elements
const loginBtn = document.getElementById('loginBtn');
const loginMsg = document.getElementById('loginMsg');
const forceResetModal = document.getElementById('forceResetModal');
const saveForceCodeBtn = document.getElementById('saveForceCodeBtn');
const forceResetMsg = document.getElementById('forceResetMsg');

// State variables to hold school data during the forced reset flow
let tempSchoolId = null;
let tempSchoolData = null;

// ── DYNAMIC LIMITS FETCHING ───────────────────────────────────────────────
async function fetchPlanDetails(planId) {
    try {
        const planSnap = await getDoc(doc(db, 'subscriptionPlans', planId || 'starter'));
        if (planSnap.exists()) {
            return { limit: planSnap.data().limit, name: planSnap.data().name };
        }
    } catch (e) { 
        console.error("Error fetching plan details:", e); 
    }
    return { limit: 50, name: 'Starter Plan' }; // Fallback
}

// ── LAUNCH DASHBOARD (SESSION SET) ────────────────────────────────────────
function launchDashboard(schoolId, data) {
    // Store necessary admin data in sessionStorage via auth.js
    setSessionData('admin', {
        schoolId: schoolId,
        schoolName: data.schoolName,
        logoUrl: data.logoUrl || '',
        activeSemesterId: data.activeSemesterId || '',
        schoolType: data.schoolType || 'Primary',
        planLimit: data.planLimit,
        planName: data.planName
    });

    // Redirect to the newly separated dashboard page
    window.location.href = './home/home.html';
}

// ── LOGIN HANDLER ─────────────────────────────────────────────────────────
loginBtn.addEventListener('click', async () => {
    const rawId = document.getElementById('loginSchoolId').value.trim();
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
        // Check exact match, upper case, and lower case to be flexible
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
            } else if (codeIn !== (data.adminCode || 'ADMIN2024')) {
                loginMsg.textContent = 'Incorrect Admin Code.';
                loginMsg.classList.remove('hidden');
            } else {
                tempSchoolId = snap.id;
                tempSchoolData = data;

                // Fetch Dynamic Plan Limits before redirecting
                const planDetails = await fetchPlanDetails(data.subscriptionPlan);
                tempSchoolData.planLimit = planDetails.limit;
                tempSchoolData.planName = planDetails.name;

                // Check if they need to update the default admin code
                if (data.requiresPinReset) {
                    forceResetModal.classList.remove('hidden');
                    // Slight delay to allow display block to register before animating opacity
                    requestAnimationFrame(() => {
                        forceResetModal.classList.remove('opacity-0');
                    });
                } else {
                    launchDashboard(tempSchoolId, tempSchoolData);
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

// ── FORCE RESET HANDLER ───────────────────────────────────────────────────
saveForceCodeBtn.addEventListener('click', async () => {
    const n = document.getElementById('newForceCode').value.trim();
    const c = document.getElementById('confirmForceCode').value.trim();
    
    forceResetMsg.classList.add('hidden');
    
    if (!n || !c) {
        forceResetMsg.textContent = 'Fill both fields.';
        forceResetMsg.classList.remove('hidden');
        return;
    }
    if (n !== c) {
        forceResetMsg.textContent = 'Codes do not match.';
        forceResetMsg.classList.remove('hidden');
        return;
    }
    if (n.length < 5) {
        forceResetMsg.textContent = 'Min. 5 characters.';
        forceResetMsg.classList.remove('hidden');
        return;
    }
    
    saveForceCodeBtn.disabled = true;
    saveForceCodeBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Updating...`;
    
    try {
        await updateDoc(doc(db, 'schools', tempSchoolId), { 
            adminCode: n, 
            requiresPinReset: false 
        });
        
        // Update local temp data
        tempSchoolData.adminCode = n;
        tempSchoolData.requiresPinReset = false;
        
        // Hide modal and launch
        forceResetModal.classList.add('opacity-0');
        setTimeout(() => {
            forceResetModal.classList.add('hidden');
            launchDashboard(tempSchoolId, tempSchoolData);
        }, 300);
        
    } catch (error) {
        console.error("Force reset update error: ", error);
        forceResetMsg.textContent = 'An error occurred. Please try again.';
        forceResetMsg.classList.remove('hidden');
        
        saveForceCodeBtn.disabled = false;
        saveForceCodeBtn.innerHTML = `Save & Continue <i class="fa-solid fa-arrow-right"></i>`;
    }
});
