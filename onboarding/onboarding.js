import { db } from '../assets/js/firebase-init.js';
import { doc, getDoc, updateDoc, writeBatch, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// DOM Elements
const loadingState  = document.getElementById('loadingState');
const setupForm     = document.getElementById('setupForm');
const successScreen = document.getElementById('successScreen');
const obErrorMsg    = document.getElementById('obErrorMsg');
const initializeBtn = document.getElementById('initializeBtn');

// State
let requestData  = null;
let isPayPalFlow = false;
const urlParams  = new URLSearchParams(window.location.search);
const reqId      = urlParams.get('req');

// ── SHA-256 Hash ──────────────────────────────────────────────────────────────
async function sha256(text) {
    const normalized  = text.toLowerCase().trim();
    const encoded     = new TextEncoder().encode(normalized);
    const hashBuffer  = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// ── Generate School ID ───────────────────────────────────────────────────────
function generateSchoolId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rand = '';
    for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return `SCH-${rand}`;
}

// ── Generate Admin ID ────────────────────────────────────────────────────────
function generateAdminId() {
    const year  = new Date().getFullYear().toString().slice(-2);
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rand = '';
    for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return `A${year}-${rand}`;
}

// ── GLOBAL EMAIL CHECK ───────────────────────────────────────────────────────
async function isEmailInUse(email, currentReqId) {
    if (!email) return false;
    const targetEmail = email.toLowerCase().trim();

    const regSnap = await getDoc(doc(db, 'registered_emails', targetEmail));
    if (regSnap.exists()) return true;

    const qSnap = await getDocs(query(collection(db, 'quote_requests'), where('workEmail', '==', targetEmail)));
    let inUseInQuotes = false;
    qSnap.forEach(d => { if (d.id !== currentReqId) inUseInQuotes = true; });
    if (inUseInQuotes) return true;

    return false;
}

// ── Security Question Mutually Exclusive Logic ───────────────────────────────
function setupSecurityQuestionLogic() {
    const q1 = document.getElementById('obSecQ1');
    const q2 = document.getElementById('obSecQ2');
    if (!q1 || !q2) return;

    function updateOptions() {
        const val1 = q1.value;
        const val2 = q2.value;
        Array.from(q1.options).forEach(opt => {
            opt.disabled = (opt.value && opt.value === val2);
            opt.hidden   = (opt.value && opt.value === val2);
        });
        Array.from(q2.options).forEach(opt => {
            opt.disabled = (opt.value && opt.value === val1);
            opt.hidden   = (opt.value && opt.value === val1);
        });
    }

    q1.addEventListener('change', updateOptions);
    q2.addEventListener('change', updateOptions);
}

// ── Render subscription summary card (PayPal flow only) ─────────────────────
function renderSubscriptionBadge(data) {
    const planName    = data.approvedPlanName   || 'ConnectUs';
    const billing     = data.approvedBillingCycle || '';
    const limits      = data.approvedLimits     || {};
    const renewalDate = data.calculatedRenewalDate
        ? new Date(data.calculatedRenewalDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        : null;

    const badge = document.getElementById('subscriptionBadge');
    if (!badge) return;

    badge.innerHTML = `
        <div class="flex items-center gap-3 mb-3">
            <div class="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center flex-shrink-0">
                <i class="fa-solid fa-circle-check text-emerald-600 text-lg"></i>
            </div>
            <div>
                <p class="text-xs font-black text-emerald-700 uppercase tracking-widest">Payment Confirmed</p>
                <p class="text-sm font-black text-slate-800">${planName}${billing ? ` — ${billing}` : ''}</p>
            </div>
        </div>
        <div class="grid grid-cols-3 gap-2 text-center">
            <div class="bg-white rounded-lg p-2 border border-emerald-100">
                <p class="text-lg font-black text-slate-800">${limits.studentLimit || '—'}</p>
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Students</p>
            </div>
            <div class="bg-white rounded-lg p-2 border border-emerald-100">
                <p class="text-lg font-black text-slate-800">${limits.teacherLimit || '—'}</p>
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Teachers</p>
            </div>
            <div class="bg-white rounded-lg p-2 border border-emerald-100">
                <p class="text-lg font-black text-slate-800">${limits.adminLimit || '—'}</p>
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Admins</p>
            </div>
        </div>
        ${renewalDate ? `<p class="text-[11px] font-semibold text-slate-400 mt-2 text-center">Renews ${renewalDate}</p>` : ''}
    `;
    badge.classList.remove('hidden');
}

// ── 1. Boot Sequence: Verify Request ID ───────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (!reqId) {
        showError("Invalid or missing invitation link. Please check your email.");
        return;
    }

    try {
        const reqSnap = await getDoc(doc(db, 'quote_requests', reqId));
        if (!reqSnap.exists()) {
            showError("Invitation link not found or has expired.");
            return;
        }

        requestData  = reqSnap.data();
        isPayPalFlow = requestData.source === 'paypal';

        if (requestData.fulfilled) {
            showError("This school has already been initialized. Please proceed to the Admin Login.");
            return;
        }

        // Pre-fill school name for manual quote subscribers
        // PayPal subscribers leave it blank — they fill it in the form
        document.getElementById('obSchoolName').value = requestData.schoolName || '';

        // ── PayPal flow: show extra fields + subscription badge ───────────────
        if (isPayPalFlow) {
            renderSubscriptionBadge(requestData);
            document.getElementById('paypalFieldsSection').classList.remove('hidden');
            document.getElementById('obSchoolName').placeholder = 'e.g. Valley Academy';
        }

        loadingState.classList.add('hidden');
        setupForm.classList.remove('hidden');
        setupSecurityQuestionLogic();

    } catch (error) {
        console.error(error);
        showError("A connection error occurred. Please refresh the page.");
    }
});

// ── 2. Initialize School Infrastructure ───────────────────────────────────────
initializeBtn.addEventListener('click', async () => {
    const schoolName = document.getElementById('obSchoolName').value.trim();
    const code       = document.getElementById('obAdminCode').value;
    const confirm    = document.getElementById('obAdminCodeConfirm').value;
    const secQ1      = document.getElementById('obSecQ1').value;
    const secA1      = document.getElementById('obSecA1').value.trim();
    const secQ2      = document.getElementById('obSecQ2').value;
    const secA2      = document.getElementById('obSecA2').value.trim();

    // Extra fields — only required for PayPal flow
    const schoolType    = isPayPalFlow ? document.getElementById('obSchoolType').value    : (requestData.schoolType    || '');
    const country       = isPayPalFlow ? document.getElementById('obCountry').value       : (requestData.country       || '');
    const city          = isPayPalFlow ? document.getElementById('obCity').value.trim()   : (requestData.city          || '');
    const phone         = isPayPalFlow ? document.getElementById('obPhone').value.trim()  : (requestData.phone         || '');

    obErrorMsg.classList.add('hidden');

    // Validation
    if (!schoolName || !code) { showValidation("All fields are required."); return; }
    if (code !== confirm)     { showValidation("Admin codes do not match."); return; }
    if (code.length < 6)      { showValidation("Admin code must be at least 6 characters."); return; }
    if (!secQ1 || !secA1)     { showValidation("Please select and answer Security Question 1."); return; }
    if (!secQ2 || !secA2)     { showValidation("Please select and answer Security Question 2."); return; }
    if (secQ1 === secQ2)      { showValidation("Please choose two different security questions."); return; }

    // Extra validation for PayPal flow
    if (isPayPalFlow) {
        if (!schoolType) { showValidation("Please select your school type."); return; }
        if (!country)    { showValidation("Please select your country."); return; }
        if (!city)       { showValidation("Please enter your city or town."); return; }
    }

    initializeBtn.disabled = true;
    initializeBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Deploying Infrastructure...';

    try {
        // ── STRICT GLOBAL EMAIL VALIDATION ───────────────────────────────────
        const emailToCheck = requestData.workEmail ? requestData.workEmail.trim() : null;
        if (emailToCheck) {
            const emailExists = await isEmailInUse(emailToCheck, reqId);
            if (emailExists) {
                showValidation("This email is already associated with an existing account. Please contact support at info@connectusonline.org.");
                initializeBtn.disabled = false;
                initializeBtn.innerHTML = 'Initialize Infrastructure →';
                return;
            }
        }

        const [hashedCode, hashedA1, hashedA2] = await Promise.all([
            sha256(code),
            sha256(secA1),
            sha256(secA2)
        ]);

        const newSchoolId     = generateSchoolId();
        const newSuperAdminId = generateAdminId();
        const batch           = writeBatch(db);

        // A. Create the core School Document
        const schoolRef = doc(db, 'schools', newSchoolId);
        batch.set(schoolRef, {
            schoolName,
            schoolType:           schoolType   || 'Unknown',
            country:              country       || '',
            city:                 city          || '',
            stateProvince:        requestData.stateProvince || '',
            logo:                 '',
            superAdminId:         newSuperAdminId,
            adminCode:            hashedCode,
            securityQ1:           secQ1,
            securityA1:           hashedA1,
            securityQ2:           secQ2,
            securityA2:           hashedA2,
            securityQuestionsSet: true,
            isSuperAdmin:         true,
            isVerified:           true,
            isActive:             true,
            requiresPinReset:     false,

            // Link back to original quote
            originalQuoteId:         reqId,

            // ── FIX: save PayPal subscription ID so webhook events can find this school ──
            paypalSubscriptionId:    requestData.paypalSubscriptionId || null,

            subscriptionPlanId:      requestData.approvedPlanId        || 'Unknown',
            subscriptionName:        requestData.approvedPlanName      || 'Custom Plan',
            billingCycle:            requestData.approvedBillingCycle  || 'Not Specified',
            nextRenewalDate:         requestData.calculatedRenewalDate || null,
            subscriptionStatus:      'Active',

            subscriptionActivatedAt: new Date().toISOString(),
            subscriptionEndedAt:     null,
            statusReason:            null,
            adminNotes:              [],

            limits:                  requestData.approvedLimits || { studentLimit: 99999, teacherLimit: 50, adminLimit: 3 },

            activeSemesterId:        'sem_1',
            contactEmail:            requestData.workEmail || '',
            contactName:             `${requestData.firstName || ''} ${requestData.lastName || ''}`.trim(),
            phone:                   phone || requestData.phone || '',
            createdAt:               new Date().toISOString()
        });

        // B. Generate Default Grading Periods
        const sems = [
            { id: 'sem_1', name: 'Term 1', order: 1 },
            { id: 'sem_2', name: 'Term 2', order: 2 },
            { id: 'sem_3', name: 'Term 3', order: 3 }
        ];
        sems.forEach(sem => {
            const semRef = doc(collection(db, 'schools', newSchoolId, 'semesters'), sem.id);
            batch.set(semRef, {
                name:      sem.name,
                order:     sem.order,
                startDate: '',
                endDate:   '',
                archived:  false,
                isLocked:  false
            });
        });

        // C. Mark the original request as fulfilled
        const reqRef = doc(db, 'quote_requests', reqId);
        batch.update(reqRef, { fulfilled: true, generatedSchoolId: newSchoolId });

        // D. Register the email globally to prevent future duplicates
        if (emailToCheck) {
            const registeredEmailRef = doc(db, 'registered_emails', emailToCheck.toLowerCase().trim());
            batch.set(registeredEmailRef, {
                email:       emailToCheck.toLowerCase().trim(),
                name:        `${requestData.firstName || ''} ${requestData.lastName || ''}`.trim(),
                role:        'admin',
                referenceId: newSchoolId,
                createdAt:   new Date().toISOString()
            });
        }

        await batch.commit();

        setupForm.classList.add('hidden');
        successScreen.classList.remove('hidden');
        document.getElementById('finalSchoolId').textContent = newSchoolId;
        document.getElementById('finalAdminId').textContent  = newSuperAdminId;

    } catch (error) {
        console.error("Initialization Failed:", error);
        showValidation("Failed to create school environment. Please try again or contact support.");
        initializeBtn.disabled = false;
        initializeBtn.innerHTML = 'Initialize Infrastructure →';
    }
});

function showError(msg) {
    loadingState.innerHTML = `
        <i class="fa-solid fa-triangle-exclamation text-4xl text-red-500 mb-4"></i>
        <p class="font-bold text-slate-600">${msg}</p>
        <a href="https://connectusonline.org" class="mt-4 inline-block text-sm font-bold text-blue-600 hover:underline">← Back to ConnectUs</a>`;
}

function showValidation(msg) {
    obErrorMsg.textContent = msg;
    obErrorMsg.classList.remove('hidden');
    obErrorMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
