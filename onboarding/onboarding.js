import { db } from '../assets/js/firebase-init.js';
import { doc, getDoc, updateDoc, writeBatch, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// DOM Elements
const loadingState  = document.getElementById('loadingState');
const setupForm     = document.getElementById('setupForm');
const successScreen = document.getElementById('successScreen');
const obErrorMsg    = document.getElementById('obErrorMsg');
const initializeBtn = document.getElementById('initializeBtn');

// State
let requestData = null;
const urlParams = new URLSearchParams(window.location.search);
const reqId     = urlParams.get('req');

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

    // 1. Check Teachers
    const tSnap = await getDocs(query(collection(db, 'teachers'), where('email', '==', targetEmail)));
    if (!tSnap.empty) return true;

    // 2. Check Students
    const sSnap = await getDocs(query(collection(db, 'students'), where('email', '==', targetEmail)));
    if (!sSnap.empty) return true;

    // 3. Check Active Schools (Admins)
    const schSnap = await getDocs(query(collection(db, 'schools'), where('contactEmail', '==', targetEmail)));
    if (!schSnap.empty) return true;

    // 4. Check Pending Quote Requests (excluding the one we are currently approving)
    const qSnap = await getDocs(query(collection(db, 'quote_requests'), where('workEmail', '==', targetEmail)));
    let inUseInQuotes = false;
    qSnap.forEach(doc => {
        if (doc.id !== currentReqId) {
            inUseInQuotes = true;
        }
    });
    if (inUseInQuotes) return true;

    return false;
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

        requestData = reqSnap.data();

        if (requestData.fulfilled) {
            showError("This school has already been initialized. Please proceed to the Admin Login.");
            return;
        }

        document.getElementById('obSchoolName').value = requestData.schoolName || '';
        if (requestData.schoolType) {
            const st = document.getElementById('obSchoolType');
            for (let i = 0; i < st.options.length; i++) {
                if (st.options[i].value === requestData.schoolType) st.selectedIndex = i;
            }
        }

        loadingState.classList.add('hidden');
        setupForm.classList.remove('hidden');

    } catch (error) {
        console.error(error);
        showError("A connection error occurred. Please refresh the page.");
    }
});

// ── 2. Initialize School Infrastructure ───────────────────────────────────────
initializeBtn.addEventListener('click', async () => {
    const schoolName = document.getElementById('obSchoolName').value.trim();
    const district   = document.getElementById('obDistrict').value;
    const schoolType = document.getElementById('obSchoolType').value;
    const code       = document.getElementById('obAdminCode').value;
    const confirm    = document.getElementById('obAdminCodeConfirm').value;
    const secQ1      = document.getElementById('obSecQ1').value;
    const secA1      = document.getElementById('obSecA1').value.trim();
    const secQ2      = document.getElementById('obSecQ2').value;
    const secA2      = document.getElementById('obSecA2').value.trim();

    obErrorMsg.classList.add('hidden');

    if (!schoolName || !district || !schoolType || !code) {
        showValidation("All fields are required."); return;
    }
    if (code !== confirm) {
        showValidation("Admin codes do not match."); return;
    }
    if (code.length < 6) {
        showValidation("Admin code must be at least 6 characters."); return;
    }
    if (!secQ1 || !secA1) {
        showValidation("Please select and answer Security Question 1."); return;
    }
    if (!secQ2 || !secA2) {
        showValidation("Please select and answer Security Question 2."); return;
    }
    if (secQ1 === secQ2) {
        showValidation("Please choose two different security questions."); return;
    }

    initializeBtn.disabled = true;
    initializeBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Deploying Infrastructure...';

    try {
        // ── LAYER 1: STRICT GLOBAL EMAIL VALIDATION ──
        const emailToCheck = requestData.workEmail ? requestData.workEmail.trim() : null;
        if (emailToCheck) {
            const emailExists = await isEmailInUse(emailToCheck, reqId);
            if (emailExists) {
                showValidation("This email is already associated with an existing account or pending request. Please contact support.");
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

        const newSchoolId = generateSchoolId();
        const newSuperAdminId = generateAdminId();
        const batch       = writeBatch(db);

        // A. Create the core School Document 
        const schoolRef = doc(db, 'schools', newSchoolId);
        batch.set(schoolRef, {
            schoolName,
            district,
            schoolType,
            superAdminId:         newSuperAdminId, 
            adminCode:            hashedCode,      
            securityQ1:           secQ1,            
            securityA1:           hashedA1,         
            securityQ2:           secQ2,            
            securityA2:           hashedA2,         
            securityQuestionsSet: true,             
            isSuperAdmin:         true,             
            isVerified:           true,
            requiresPinReset:     false,
            
            // Link back to original quote for transaction history
            originalQuoteId:      reqId, 
            
            subscriptionPlanId:   requestData.approvedPlanId || 'Unknown',
            subscriptionName:     requestData.approvedPlanName || 'Custom Plan',
            billingCycle:         requestData.approvedBillingCycle || 'Not Specified',
            nextRenewalDate:      requestData.calculatedRenewalDate || null,
            subscriptionStatus:   'Active',
            limits:               requestData.approvedLimits || { studentLimit: 99999, teacherLimit: 50, adminLimit: 3 },

            activeSemesterId:     'sem_1',
            contactEmail:         requestData.workEmail || '',
            contactName:          `${requestData.firstName || ''} ${requestData.lastName || ''}`.trim(),
            phone:                requestData.phone || '',
            createdAt:            new Date().toISOString()
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

        await batch.commit();

        setupForm.classList.add('hidden');
        successScreen.classList.remove('hidden');
        document.getElementById('finalSchoolId').textContent = newSchoolId;
        document.getElementById('finalAdminId').textContent = newSuperAdminId; 

    } catch (error) {
        console.error("Initialization Failed:", error);
        showValidation("Failed to create school environment. Please check the console.");
        initializeBtn.disabled = false;
        initializeBtn.innerHTML = 'Initialize Infrastructure →';
    }
});

function showError(msg) {
    loadingState.innerHTML = `
        <i class="fa-solid fa-triangle-exclamation text-4xl text-red-500 mb-4"></i>
        <p class="font-bold text-slate-600">${msg}</p>`;
}

function showValidation(msg) {
    obErrorMsg.textContent = msg;
    obErrorMsg.classList.remove('hidden');
}
