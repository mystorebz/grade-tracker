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
        let userCredential;
        try {
            const authResult = await mintAdminToken({ schoolId: rawId, adminCode: codeIn });
            userCredential = await signInWithCustomToken(auth, authResult.data.token);
        } catch (authError) {
            console.error('[Admin Login] Server rejected:', authError);

            // ── Suspended / expired school ────────────────────────────────────
            // mintAdminToken throws 'failed-precondition' specifically for
            // schools where isVerified === false. We fetch the school data
            // here to populate the deactivated page with the right information.
            if (authError?.code === 'functions/failed-precondition') {
                try {
                    // Try uppercase first (standard School ID format), then as-entered
                    let schoolSnap = await getDoc(doc(db, 'schools', rawId.toUpperCase()));
                    if (!schoolSnap.exists()) {
                        schoolSnap = await getDoc(doc(db, 'schools', rawId));
                    }

                    if (!schoolSnap.exists()) {
                        showLoginError('School ID not found. Please check and try again.');
                        return;
                    }

                    const schoolData = schoolSnap.data();

                    setSessionData('admin', {
                        schoolId:           schoolSnap.id,
                        role:               'super_admin',
                        isSuperAdmin:       true,
                        schoolName:         schoolData.schoolName         || '',
                        contactEmail:       schoolData.contactEmail       || '',
                        planName:           schoolData.subscriptionName   || schoolData.planName || '',
                        subscriptionStatus: schoolData.subscriptionStatus || 'Expired',
                        statusReason:       schoolData.statusReason       || '',
                        nextRenewalDate:    schoolData.nextRenewalDate     || null,
                        billingCycle:       schoolData.billingCycle        || '',
                        activeSemesterId:   schoolData.activeSemesterId    || ''
                    });

                    window.location.replace('deactivated/deactivated.html');

                } catch (fetchError) {
                    console.error('[Admin Login] Failed to fetch suspended school data:', fetchError);
                    showLoginError('Your account is currently inactive. Please contact support at info@connectusonline.org.');
                }
                return;
            }

            // ── School ID not found ───────────────────────────────────────────
            if (authError?.code === 'functions/not-found') {
                showLoginError('School ID not found. Please check and try again.');
                return;
            }

            // ── Wrong admin code or any other auth rejection ──────────────────
            showLoginError('Incorrect Admin Code or School ID.');
            return;
        }

        // 2. READ CLAIMS FROM THE SIGNED TOKEN — NOT FROM THE FUNCTION RESPONSE
        const idTokenResult = await userCredential.user.getIdTokenResult();
        const claims        = idTokenResult.claims;

        const schoolId = claims.schoolId;
        const role     = claims.role;
        const adminId  = claims.adminId || null;

        if (!schoolId || !role) {
            showLoginError('Authentication error. Please try again.');
            return;
        }

        // 3. FETCH SCHOOL DATA
        const schoolSnap = await getDoc(doc(db, 'schools', schoolId));
        const schoolData = schoolSnap.data();

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
            const adminSnap = await getDoc(doc(db, 'schools', schoolId, 'admins', adminId));
            tempAdminData = adminSnap.data();
            tempAdminId   = adminId;

            // Archived sub-admin — redirect to deactivated page
            if (tempAdminData.isArchived === true) {
                setSessionData('admin', {
                    schoolId,
                    adminId,
                    role:         'sub_admin',
                    isSuperAdmin: false,
                    schoolName:   tempSchoolData.schoolName || '',
                    adminName:    tempAdminData.name        || '',
                    adminEmail:   tempAdminData.email       || ''
                });
                window.location.replace('deactivated/deactivated.html');
                return;
            }

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

// ── Force Reset Handler ───────────────────────────────────────────────────────
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

        document.getElementById('newForceCode').value    = '';
        document.getElementById('confirmForceCode').value = '';
        document.getElementById('loginAdminCode').value  = '';

        hideForceReset();
        showLoginError('PIN updated successfully. Please log in with your new PIN.');

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
