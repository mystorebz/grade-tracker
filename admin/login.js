import { db } from '../assets/js/firebase-init.js';
import {
    doc, getDoc, updateDoc,
    collection, query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { setSessionData } from '../assets/js/auth.js';

// ── DOM Elements ──────────────────────────────────────────────────────────────
const loginBtn         = document.getElementById('loginBtn');
const loginMsg         = document.getElementById('loginMsg');
const forceResetModal  = document.getElementById('forceResetModal');
const saveForceCodeBtn = document.getElementById('saveForceCodeBtn');
const forceResetMsg    = document.getElementById('forceResetMsg');

// ── State ─────────────────────────────────────────────────────────────────────
let tempSchoolId   = null;
let tempSchoolData = null;
let tempAdminRole  = null;   // 'super_admin' | 'sub_admin'
let tempAdminId    = null;   // null for super_admin; sub-admin doc ID for sub_admin
let tempAdminData  = null;   // null for super_admin; sub-admin doc data for sub_admin

// ── SHA-256 ───────────────────────────────────────────────────────────────────
// Same normalization (lowercase + trim) used across all ConnectUs auth flows.
async function sha256(text) {
    const normalized  = text.toLowerCase().trim();
    const encoded     = new TextEncoder().encode(normalized);
    const hashBuffer  = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

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
// Sets session BEFORE any gate redirect so first-time-setup can read it.
function launchDashboard(schoolId, schoolData, role, adminId, adminData) {
    const session = {
        schoolId,
        adminId:          adminId || schoolId,
        role,                                          // 'super_admin' | 'sub_admin'
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

    // For sub-admins, also store their personal info
    if (role === 'sub_admin' && adminData) {
        session.adminName  = adminData.name  || '';
        session.adminEmail = adminData.email || '';
    }

    setSessionData('admin', session);

    // ── Gate: security questions not set ──────────────────────────────────────
    // Super admins: checked against school doc (set during onboarding).
    // Sub-admins: checked against their own admin doc.
    const questionsSet = role === 'super_admin'
        ? schoolData.securityQuestionsSet
        : adminData?.securityQuestionsSet;

    if (!questionsSet) {
        window.location.href = '../onboarding/first-time-setup.html?role=admin';
        return;
    }

    window.location.href = './home/home.html';
}

// ── Login Handler ─────────────────────────────────────────────────────────────
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
        // ── Find school document ──────────────────────────────────────────────
        let schoolSnap;
        for (const id of [rawId.toUpperCase(), rawId.toLowerCase(), rawId]) {
            schoolSnap = await getDoc(doc(db, 'schools', id));
            if (schoolSnap.exists()) break;
        }

        if (!schoolSnap || !schoolSnap.exists()) {
            showLoginError('School ID not found.');
            return;
        }

        const schoolData = schoolSnap.data();
        const schoolId   = schoolSnap.id;

        if (schoolData.isVerified !== true) {
            showLoginError('Account pending approval. Contact ConnectUs.');
            return;
        }

        // ── Path 1: Try Super Admin (hash comparison against school doc) ──────
        const hashedInput = await sha256(codeIn);
        let superAdminMatch = false;

        if (hashedInput === schoolData.adminCode) {
            // New hashed flow
            superAdminMatch = true;
        } else if (codeIn === (schoolData.adminCode || 'ADMIN2024')) {
            // Legacy plain-text — auto-upgrade silently
            superAdminMatch = true;
            await updateDoc(doc(db, 'schools', schoolId), { adminCode: hashedInput });
            schoolData.adminCode = hashedInput;
        }

        if (superAdminMatch) {
            tempSchoolId   = schoolId;
            tempSchoolData = schoolData;
            tempAdminRole  = 'super_admin';
            tempAdminId    = null;
            tempAdminData  = null;

            const planDetails = await fetchPlanDetails(schoolData.subscriptionPlan);
            tempSchoolData.planLimit     = planDetails.limit;
            tempSchoolData.planName      = planDetails.name;
            tempSchoolData.teacherLimit  = planDetails.teacherLimit;
            tempSchoolData.adminLimit    = planDetails.adminLimit;
            tempSchoolData.studentLimit  = planDetails.studentLimit;

            if (schoolData.requiresPinReset) {
                showForceReset();
            } else {
                launchDashboard(tempSchoolId, tempSchoolData, 'super_admin', null, null);
            }
            return;
        }

        // ── Path 2: Try Sub-Admin (check schools/{schoolId}/admins) ──────────
        const adminsSnap = await getDocs(
            query(collection(db, 'schools', schoolId, 'admins'),
                  where('isArchived', '==', false))
        );

        let subAdminMatch = false;
        let matchedAdminId   = null;
        let matchedAdminData = null;

        for (const adminDoc of adminsSnap.docs) {
            const aData = adminDoc.data();

            // Hash comparison — sub-admin codes are always stored hashed
            if (hashedInput === aData.adminCode) {
                subAdminMatch    = true;
                matchedAdminId   = adminDoc.id;
                matchedAdminData = aData;
                break;
            }
        }

        if (subAdminMatch) {
            tempSchoolId   = schoolId;
            tempSchoolData = schoolData;
            tempAdminRole  = 'sub_admin';
            tempAdminId    = matchedAdminId;
            tempAdminData  = matchedAdminData;

            const planDetails = await fetchPlanDetails(schoolData.subscriptionPlan);
            tempSchoolData.planLimit     = planDetails.limit;
            tempSchoolData.planName      = planDetails.name;
            tempSchoolData.teacherLimit  = planDetails.teacherLimit;
            tempSchoolData.adminLimit    = planDetails.adminLimit;
            tempSchoolData.studentLimit  = planDetails.studentLimit;

            if (matchedAdminData.requiresPinReset) {
                showForceReset();
            } else {
                launchDashboard(tempSchoolId, tempSchoolData, 'sub_admin', matchedAdminId, matchedAdminData);
            }
            return;
        }

        // ── Neither matched ───────────────────────────────────────────────────
        showLoginError('Incorrect Admin Code.');

    } catch (e) {
        console.error('[Admin Login]', e);
        showLoginError('Connection error. Please try again.');
    }
});

// ── Force Reset Handler ───────────────────────────────────────────────────────
// Hashes the new code before saving, consistent with all other auth flows.
saveForceCodeBtn.addEventListener('click', async () => {
    const n = document.getElementById('newForceCode').value.trim();
    const c = document.getElementById('confirmForceCode').value.trim();

    forceResetMsg.classList.add('hidden');

    if (!n || !c)       { showForceError('Fill both fields.');    return; }
    if (n !== c)        { showForceError('Codes do not match.');  return; }
    if (n.length < 5)   { showForceError('Min. 5 characters.');   return; }

    saveForceCodeBtn.disabled = true;
    saveForceCodeBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Updating...`;

    try {
        const hashedNew = await sha256(n);

        if (tempAdminRole === 'super_admin') {
            await updateDoc(doc(db, 'schools', tempSchoolId), {
                adminCode:        hashedNew,
                requiresPinReset: false
            });
            tempSchoolData.adminCode        = hashedNew;
            tempSchoolData.requiresPinReset = false;
        } else {
            // Sub-admin — update their own doc in the subcollection
            await updateDoc(doc(db, 'schools', tempSchoolId, 'admins', tempAdminId), {
                adminCode:        hashedNew,
                requiresPinReset: false
            });
            tempAdminData.adminCode        = hashedNew;
            tempAdminData.requiresPinReset = false;
        }

        hideForceReset();
        launchDashboard(tempSchoolId, tempSchoolData, tempAdminRole, tempAdminId, tempAdminData);

    } catch (error) {
        console.error('[Admin Login] force reset:', error);
        showForceError('An error occurred. Please try again.');
        saveForceCodeBtn.disabled = false;
        saveForceCodeBtn.innerHTML = `Save & Continue <i class="fa-solid fa-arrow-right"></i>`;
    }
});

// ── UI Helpers ────────────────────────────────────────────────────────────────
function showLoginError(msg) {
    loginMsg.textContent = msg;
    loginMsg.classList.remove('hidden');
    loginBtn.disabled = false;
    loginBtn.innerHTML = `<i class="fa-solid fa-arrow-right-to-bracket"></i> Secure Login`;
}

function showForceReset() {
    forceResetModal.classList.remove('hidden');
    requestAnimationFrame(() => forceResetModal.classList.remove('opacity-0'));
}

function hideForceReset() {
    forceResetModal.classList.add('opacity-0');
    setTimeout(() => forceResetModal.classList.add('hidden'), 300);
}

function showForceError(msg) {
    forceResetMsg.textContent = msg;
    forceResetMsg.classList.remove('hidden');
}
