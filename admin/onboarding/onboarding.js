import { db } from '../assets/js/firebase-init.js';
import { doc, getDoc, setDoc, updateDoc, writeBatch, collection } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// DOM Elements
const loadingState = document.getElementById('loadingState');
const setupForm = document.getElementById('setupForm');
const successScreen = document.getElementById('successScreen');
const obErrorMsg = document.getElementById('obErrorMsg');
const initializeBtn = document.getElementById('initializeBtn');

// State
let requestData = null;
const urlParams = new URLSearchParams(window.location.search);
const reqId = urlParams.get('req');

// Helper: Generate School ID (e.g., SCH-8B2X9)
function generateSchoolId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rand = '';
    for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return `SCH-${rand}`;
}

// 1. Boot Sequence: Verify Request ID
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

        // Security check: Has this request already been converted?
        if (requestData.fulfilled) {
            showError("This school has already been initialized. Please proceed to the Admin Login.");
            return;
        }

        // Pre-fill form
        document.getElementById('obSchoolName').value = requestData.schoolName || '';
        if (requestData.schoolType) {
            const st = document.getElementById('obSchoolType');
            // Select matching option if exists
            for(let i=0; i<st.options.length; i++) {
                if(st.options[i].value === requestData.schoolType) st.selectedIndex = i;
            }
        }

        // Show form
        loadingState.classList.add('hidden');
        setupForm.classList.remove('hidden');

    } catch (error) {
        console.error(error);
        showError("A connection error occurred. Please refresh the page.");
    }
});

// 2. Initialize School Infrastructure
initializeBtn.addEventListener('click', async () => {
    const schoolName = document.getElementById('obSchoolName').value.trim();
    const district = document.getElementById('obDistrict').value;
    const schoolType = document.getElementById('obSchoolType').value;
    const code = document.getElementById('obAdminCode').value;
    const confirm = document.getElementById('obAdminCodeConfirm').value;

    obErrorMsg.classList.add('hidden');

    // Validation
    if (!schoolName || !district || !schoolType || !code) {
        showValidation("All fields are required."); return;
    }
    if (code !== confirm) {
        showValidation("Admin codes do not match."); return;
    }
    if (code.length < 6) {
        showValidation("Admin code must be at least 6 characters."); return;
    }

    initializeBtn.disabled = true;
    initializeBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Deploying Infrastructure...';

    try {
        const newSchoolId = generateSchoolId();
        const batch = writeBatch(db);

        // A. Create the core School Document
        const schoolRef = doc(db, 'schools', newSchoolId);
        batch.set(schoolRef, {
            schoolName,
            district,
            schoolType,
            adminCode: code,
            isVerified: true,              // Ready to log in immediately
            requiresPinReset: false,       // They just set it
            subscriptionPlan: 'pro',       // You can map this dynamically later
            activeSemesterId: 'sem_1',     // We will create this below
            contactEmail: requestData.workEmail || '',
            contactName: `${requestData.firstName} ${requestData.lastName}` || '',
            phone: requestData.phone || '',
            createdAt: new Date().toISOString()
        });

        // B. Generate Default Grading Periods (Semesters)
        const sems = [
            { id: 'sem_1', name: 'Term 1', order: 1 },
            { id: 'sem_2', name: 'Term 2', order: 2 },
            { id: 'sem_3', name: 'Term 3', order: 3 }
        ];
        
        sems.forEach(sem => {
            const semRef = doc(collection(db, 'schools', newSchoolId, 'semesters'), sem.id);
            batch.set(semRef, {
                name: sem.name,
                order: sem.order,
                startDate: '',
                endDate: '',
                archived: false,
                isLocked: false
            });
        });

        // C. Mark the original request as fulfilled
        const reqRef = doc(db, 'quote_requests', reqId);
        batch.update(reqRef, { fulfilled: true, generatedSchoolId: newSchoolId });

        // Execute all writes atomically
        await batch.commit();

        // D. Show Success
        setupForm.classList.add('hidden');
        successScreen.classList.remove('hidden');
        document.getElementById('finalSchoolId').textContent = newSchoolId;

    } catch (error) {
        console.error("Initialization Failed: ", error);
        showValidation("Failed to create school environment. Check console.");
        initializeBtn.disabled = false;
        initializeBtn.innerHTML = 'Initialize Infrastructure →';
    }
});

// UI Helpers
function showError(msg) {
    loadingState.innerHTML = `<i class="fa-solid fa-triangle-exclamation text-4xl text-red-500 mb-4"></i><p class="font-bold text-slate-600">${msg}</p>`;
}

function showValidation(msg) {
    obErrorMsg.textContent = msg;
    obErrorMsg.classList.remove('hidden');
}
