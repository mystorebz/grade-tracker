import { db } from './firebase-init.js';
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ── NAVBAR SCROLL EFFECT ──
const nav = document.getElementById('navbar');
if (nav) {
    window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 20));
}

// ── CONTRACT TERM CONDITIONAL LOGIC ──
const contractTermSelect = document.getElementById('contractTerm');
const yearsWrap = document.getElementById('contractYearsWrap');

if (contractTermSelect) {
    contractTermSelect.addEventListener('change', () => {
        const val = contractTermSelect.value;
        yearsWrap.classList.add('hidden');
        if (val === 'Multi-Year') yearsWrap.classList.remove('hidden');
    });
}

// ── QUOTE FORM LOGIC ──
const registerBtn = document.getElementById('registerBtn');

if (registerBtn) {
    registerBtn.addEventListener('click', async () => {
        const msgEl = document.getElementById('regMessage');

        // Collect all fields
        const firstName      = document.getElementById('firstName').value.trim();
        const lastName       = document.getElementById('lastName').value.trim();
        const jobTitle       = document.getElementById('jobTitle').value.trim();
        const workEmail      = document.getElementById('workEmail').value.trim();
        const phone          = document.getElementById('phone').value.trim();
        const schoolName     = document.getElementById('schoolName').value.trim();
        const schoolType     = document.getElementById('schoolType').value;
        const country        = document.getElementById('country').value;
        const city           = document.getElementById('city').value.trim();
        const stateProvince  = document.getElementById('stateProvince').value.trim();
        const studentsCount  = document.getElementById('studentsCount').value.trim();
        const teachersCount  = document.getElementById('teachersCount').value.trim();
        const contractTerm   = document.getElementById('contractTerm').value;
        const contractYears  = document.getElementById('contractYears')?.value || null;
        const hearAboutUs    = document.getElementById('hearAboutUs').value;
        const message        = document.getElementById('message').value.trim();

        // Validation - Strict check for ALL required fields
        if (!firstName || !lastName || !jobTitle || !workEmail || !phone ||
            !schoolName || !schoolType || !country || !city || !stateProvince ||
            !studentsCount || !teachersCount || !contractTerm || !hearAboutUs || !message) {
            msgEl.textContent = "Please fill in all required fields (*).";
            msgEl.className = "text-sm text-center font-bold mt-2 text-red-600 block";
            return;
        }
        
        if (contractTerm === 'Multi-Year' && !contractYears) {
            msgEl.textContent = "Please select how many years for your multi-year contract.";
            msgEl.className = "text-sm text-center font-bold mt-2 text-red-600 block";
            return;
        }
        
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(workEmail)) {
            msgEl.textContent = "Please enter a valid email address.";
            msgEl.className = "text-sm text-center font-bold mt-2 text-red-600 block";
            return;
        }

        btnLoadingState(true);

        const timestamp = new Date().toISOString();
        const fullName  = `${firstName} ${lastName}`;

        // Build a readable contract term string for emails
        let contractSummary = contractTerm;
        if (contractTerm === '6 Months') contractSummary = '6 Month Contract';
        if (contractTerm === 'Annual') contractSummary = 'Annual Contract (1 Year)';
        if (contractTerm === 'Multi-Year') contractSummary = `Multi-Year Contract (${contractYears} Years)`;

        try {
            // Generate Request ID (e.g. REQ-9A2B4) to match the onboarding flow
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            let rand = '';
            for (let i = 0; i < 5; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
            const reqId = `REQ-${rand}`;

            // ── Write 1: quote_requests collection to Firebase ──
            await setDoc(doc(db, 'quote_requests', reqId), {
                requestId:      reqId,
                firstName,
                lastName,
                fullName,
                jobTitle,
                workEmail,
                phone,
                schoolName,
                schoolType,
                country,
                city,
                stateProvince,
                studentsCount:  parseInt(studentsCount),
                teachersCount:  parseInt(teachersCount),
                contractTerm,
                contractYears:  contractTerm === 'Multi-Year' ? parseInt(contractYears) : null,
                hearAboutUs,
                message,
                status:         'Pending',
                fulfilled:      false,
                createdAt:      timestamp,
            });

            // Show success screen
            document.getElementById('registrationFormContainer').classList.add('hidden');
            document.getElementById('successScreen').classList.remove('hidden');
            document.getElementById('successScreen').scrollIntoView({ behavior: 'smooth', block: 'center' });

        } catch (error) {
            console.error("Quote submission error:", error);
            msgEl.textContent = "Error submitting your request. Please try again.";
            msgEl.className = "text-sm text-center font-bold mt-2 text-red-600 block";
            btnLoadingState(false);
        }
    });
}

function btnLoadingState(isLoading) {
    const btn   = document.getElementById('registerBtn');
    const msgEl = document.getElementById('regMessage');
    if (isLoading) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Submitting...';
        btn.classList.add("opacity-75", "cursor-not-allowed");
        msgEl.textContent = "Sending your request...";
        msgEl.className = "text-sm text-center font-bold mt-2 text-blue-600 block";
    } else {
        btn.disabled = false;
        btn.innerHTML = "Request a Quote →";
        btn.classList.remove("opacity-75", "cursor-not-allowed");
    }
}
