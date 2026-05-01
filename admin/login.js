import { db, auth } from '../assets/js/firebase-init.js';
import {
    doc, getDoc, updateDoc,
    collection, query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { signInWithCustomToken }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFunctions, httpsCallable }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { setSessionData } from '../assets/js/auth.js';

// ── Functions instance ────────────────────────────────────────────────────────
const functions       = getFunctions();
const mintAdminToken  = httpsCallable(functions, 'mintAdminToken');

// ── DOM Elements ──────────────────────────────────────────────────────────────
const loginBtn         = document.getElementById('loginBtn');
const loginMsg         = document.getElementById('loginMsg');
const forceResetModal  = document.getElementById('forceResetModal');
const saveForceCodeBtn = document.getElementById('saveForceCodeBtn');
const forceResetMsg    = document.getElementById('forceResetMsg');

// ── State ─────────────────────────────────────────────────────────────────────
let tempSchoolId   = null;
let tempSchoolData = null;
let tempAdminRole  = null;
let tempAdminId    = null;
let tempAdminData  = null;

// NOTE: sha256() HAS BEEN COMPLETELY REMOVED. THE SERVER HANDLES THIS NOW.

// ── Fetch Plan Details ────────────────────────────────────────────────────────
async function fetchPlanDetails(planId) {
    try {
        const planSnap = await getDoc(doc(db, 'subscriptionPlans', planId || 'starter'));
        if (planSnap.exists()) {
            return {
                limit:        planSnap.data().limit        || 50,
                name:         planSnap.data().name         || 'Starter',
                teacherLimit: planSnap.data().teacherLimit || 10,
                adminLimit:   planSnap.data().adminLimit   || 1,
                studentLimit: planSnap.data().studentLimit || 50
            };
        }
    } catch (e) {
        console.error('[Admin Login] fetchPlanDetails:', e);
    }
    return { limit: 50, name: 'Starter', teacherLimit: 10, adminLimit: 1, studentLimit: 50 };
}

// ── Launch Dashboard ──────────────────────────────────────────────────────────
async function launchDashboard(schoolId, schoolData, role, adminId, adminData) {
    const session = {
        schoolId,
        adminId:          adminId || schoolId,
        role,
        isSuperAdmin:     role === 'super_admin',
        schoolName:       schoolData.schoolName       || '',
        contactEmail:     schoolData.contactEmail     || '',
        logoUrl:          schoolData.logoUrl          || '',
        activeSemesterId: schoolData.activeSemesterId || '',
        schoolType:       schoolData.schoolType       || 'Primary',
        planLimit:        schoolData.planLimit,
        planName:         schoolData.planName,
        teacherLimit:     schoolData.teacherLimit,
        adminLimit:       schoolData.adminLimit,
        studentLimit:     schoolData.studentLimit
    };

    if (role === 'sub_admin' && adminData) {
        session.adminName  = adminData.name  || '';
        session.adminEmail = adminData.email || '';
    }

    setSessionData('admin', session);

    const questionsSet = role === 'super_admin'
        ? schoolData.securityQuestionsSet
        : adminData?.securityQuestionsSet;

    if (!questionsSet) {
        window.location.href = `../onboarding/first-time-setup.html?role=${role}`;
        return;
    }

    window.location.href = './home/home.html';
}

// ── Login Handler ─────────────────────────────────────────────────────────────
loginBtn.addEventListener('click', async () => {
    const rawId  = document.getElementById('loginSchoolId').value.trim();
    const codeIn = document.getElementById('loginAdminCode').value.trim();

    loginMsg.classList.remove('show');

    if (!rawId || !codeIn) {
        showLoginError('Please enter both fields.');
        return;
    }

    loginBtn.disabled  = true;
    loginBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Authenticating...`;

    try {
        // 1. LET THE CLOUD FUNCTION BE THE GATEKEEPER FIRST
        let authResult;
        try {
            authResult = await mintAdminToken({ schoolId: rawId, adminCode: codeIn });
            await signInWithCustomToken(auth, authResult.data.token);
        } catch (authError) {
            console.error('[Admin Login] Server rejected PIN:', authError);
            showLoginError('Incorrect Admin Code or School ID.');
            return; // STOP EXECUTION HERE IF SERVER REJECTS
        }

        // 2. IF WE GET HERE, THE SERVER VERIFIED THE PIN. NOW FETCH DATA.
        // We use the exact schoolId the server validated (avoids casing issues)
        const schoolId = authResult.data.schoolId || rawId.toUpperCase(); 
        const role = authResult.data.role; // CF should return 'super_admin' or 'sub_admin'
        const adminId = authResult.data.adminId || null;

        const schoolSnap = await getDoc(doc(db, 'schools', schoolId));
        const schoolData = schoolSnap.data();

        if (schoolData.isVerified !== true) {
            showLoginError('Account pending approval. Contact ConnectUs.');
            return;
        }

        tempSchoolId   = schoolId;
        tempSchoolData = schoolData;
        tempAdminRole  = role;
        
        const planDetails = await fetchPlanDetails(schoolData.subscriptionPlan);
        tempSchoolData.planLimit     = planDetails.limit;
        tempSchoolData.planName      = planDetails.name;
        tempSchoolData.teacherLimit  = planDetails.teacherLimit;
        tempSchoolData.adminLimit    = planDetails.adminLimit;
        tempSchoolData.studentLimit  = planDetails.studentLimit;

        if (role === 'super_admin') {
            tempAdminId   = null;
            tempAdminData = null;

            if (schoolData.requiresPinReset) {
                showForceReset();
            } else {
                await launchDashboard(tempSchoolId, tempSchoolData, 'super_admin', null, null);
            }
        } else {
            // Fetch the sub-admin's specific data
            const adminSnap = await getDoc(doc(db, 'schools', schoolId, 'admins', adminId));
            tempAdminData = adminSnap.data();
            tempAdminId   = adminId;

            if (tempAdminData.requiresPinReset) {
                showForceReset();
            } else {
                await launchDashboard(tempSchoolId, tempSchoolData, 'sub_admin', tempAdminId, tempAdminData);
            }
        }

    } catch (e) {
        console.error('[Admin Login] Unexpected error:', e);
        showLoginError('Connection error. Please try again.');
    }
});

// ── Force Reset Handler (UX FIXED) ────────────────────────────────────────────
saveForceCodeBtn.addEventListener('click', async () => {
    const n = document.getElementById('newForceCode').value.trim();
    const c = document.getElementById('confirmForceCode').value.trim();

    forceResetMsg.classList.add('hidden');

    if (!n || !c)     { showForceError('Fill both fields.');   return; }
    if (n !== c)      { showForceError('Codes do not match.'); return; }
    if (n.length < 5) { showForceError('Min. 5 characters.');  return; }

    saveForceCodeBtn.disabled  = true;
    saveForceCodeBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Updating Server...`;

    try {
        // Note: The hashing should ideally happen on the server via a Cloud Function for resets too,
        // but if your updateDoc rules still expect a raw write, we need a lightweight hash here, 
        // OR better yet, pass the new raw PIN to a 'resetAdminPin' Cloud Function.
        // Assuming your backend expects a newly generated hash to be written directly for now:
        
        // (Temporary recreation of SHA just for the write, though a CF is preferred)
        const encoded = new TextEncoder().encode(n.toLowerCase().trim());
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
        const hashedNew = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

        if (tempAdminRole === 'super_admin') {
            await updateDoc(doc(db, 'schools', tempSchoolId), {
                adminCode: hashedNew, requiresPinReset: false
            });
        } else {
            await updateDoc(doc(db, 'schools', tempSchoolId, 'admins', tempAdminId), {
                adminCode: hashedNew, requiresPinReset: false
            });
        }

        // UX FIX: DO NOT AUTO LOGIN. Force manual entry to clear DOM state.
        document.getElementById('newForceCode').value = '';
        document.getElementById('confirmForceCode').value = '';
        document.getElementById('loginAdminCode').value = ''; // Clear old PIN
        
        hideForceReset();
        showLoginError('PIN updated successfully. Please log in with your new PIN.');
        
        // Reset button state
        saveForceCodeBtn.disabled  = false;
        saveForceCodeBtn.innerHTML = `Save & Continue <i class="fa-solid fa-arrow-right"></i>`;

    } catch (error) {
        console.error('[Admin Login] force reset:', error);
        showForceError('An error occurred. Please try again.');
        saveForceCodeBtn.disabled  = false;
        saveForceCodeBtn.innerHTML = `Save & Continue <i class="fa-solid fa-arrow-right"></i>`;
    }
});

// ── UI Helpers ────────────────────────────────────────────────────────────────
function showLoginError(msg) {
    loginMsg.textContent = msg;
    loginMsg.classList.add('show');
    loginMsg.classList.remove('hidden');
    loginBtn.disabled  = false;
    loginBtn.innerHTML = `<i class="fa-solid fa-arrow-right-to-bracket"></i> Secure Login`;
}

function showForceReset()     { forceResetModal.classList.add('open');    }
function hideForceReset()     { forceResetModal.classList.remove('open'); }
function showForceError(msg)  { forceResetMsg.textContent = msg; forceResetMsg.classList.add('show'); forceResetMsg.classList.remove('hidden'); }
