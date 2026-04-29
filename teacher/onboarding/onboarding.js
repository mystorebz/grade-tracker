import { db } from '../../assets/js/firebase-init.js';
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';

// ── AUTH GUARD & ROUTING ──────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (!session) throw new Error('No session');

const tData = session.teacherData;

// If EVERYTHING is done, bypass onboarding and go straight to the dashboard
if (tData?.profileComplete === true && tData?.requiresPinReset === false && tData?.securityQuestionsSet === true) {
    window.location.replace('../home/home.html');
}

// ── UI INITIALIZATION ─────────────────────────────────────────────────────────
const nameEl = document.getElementById('welcomeTeacherName');
if (nameEl && tData?.name) {
    nameEl.textContent = `Welcome, ${tData.name}`;
}

const step1Container = document.getElementById('step1Container');
const step2Container = document.getElementById('step2Container');

// Determine which phase to show on load
if (tData?.requiresPinReset === false && tData?.securityQuestionsSet === true) {
    // Phase 1 is already complete; jump straight to Phase 2
    step1Container.classList.add('hidden');
    step2Container.classList.remove('hidden');
} else {
    // Show Phase 1
    step1Container.classList.remove('hidden');
    step2Container.classList.add('hidden');
}

// ── PHASE 1: PIN & SECURITY QUESTIONS ─────────────────────────────────────────
document.getElementById('saveStep1Btn')?.addEventListener('click', async () => {
    const newPin     = document.getElementById('newPin').value.trim();
    const confirmPin = document.getElementById('confirmPin').value.trim();
    const secQ1      = document.getElementById('secQ1').value;
    const secA1      = document.getElementById('secA1').value.trim();
    const secQ2      = document.getElementById('secQ2').value;
    const secA2      = document.getElementById('secA2').value.trim();
    const msgEl      = document.getElementById('step1Msg');
    const btn        = document.getElementById('saveStep1Btn');

    msgEl.classList.add('hidden');

    // Strict Validation
    if (!newPin || !confirmPin || !secQ1 || !secA1 || !secQ2 || !secA2) {
        msgEl.textContent = 'Please fill out all security fields.';
        msgEl.classList.remove('hidden');
        return;
    }
    if (newPin.length < 6) { // Adjust based on your PIN length requirements
        msgEl.textContent = 'PIN must be at least 6 digits.';
        msgEl.classList.remove('hidden');
        return;
    }
    if (newPin !== confirmPin) {
        msgEl.textContent = 'Your new PINs do not match.';
        msgEl.classList.remove('hidden');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Securing Account...`;

    try {
        const securityData = {
            pin: newPin,
            requiresPinReset: false,
            securityQuestionsSet: true,
            securityQuestions: [
                { question: secQ1, answer: secA1.toLowerCase() },
                { question: secQ2, answer: secA2.toLowerCase() }
            ]
        };

        // Update the global teacher document
        await updateDoc(doc(db, 'teachers', session.teacherId), securityData);

        // Update local session so auth isn't broken
        const updatedSession = {
            ...session,
            teacherData: {
                ...session.teacherData,
                ...securityData
            }
        };
        setSessionData('teacher', updatedSession);

        // Transition to Phase 2
        step1Container.classList.add('hidden');
        step2Container.classList.remove('hidden');

    } catch (e) {
        console.error('[Onboarding Phase 1]', e);
        msgEl.textContent = 'System error saving credentials. Please try again.';
        msgEl.classList.remove('hidden');
        btn.disabled = false;
        btn.innerHTML = `Save Security Settings`;
    }
});

// ── PHASE 2: PROFILE INFORMATION ──────────────────────────────────────────────
document.getElementById('saveStep2Btn')?.addEventListener('click', async () => {
    const country  = document.getElementById('obCountry').value;
    const district = document.getElementById('obDistrict').value;
    const town     = document.getElementById('obTown').value.trim();
    const years    = document.getElementById('obYears').value;
    const msgEl    = document.getElementById('step2Msg');
    const btn      = document.getElementById('saveStep2Btn');

    msgEl.classList.add('hidden');

    if (!country || !district) {
        msgEl.textContent = 'Country and District are required fields.';
        msgEl.classList.remove('hidden');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Finalizing Setup...`;

    try {
        const profileData = {
            profileComplete: true,
            address: {
                country,
                district,
                town:  town  || '',
                years: years || ''
            }
        };

        // Final database update
        await updateDoc(doc(db, 'teachers', session.teacherId), profileData);

        // Final session update
        const updatedSession = {
            ...session,
            teacherData: {
                ...session.teacherData,
                profileComplete: true,
                address: profileData.address
            }
        };
        setSessionData('teacher', updatedSession);

        // Enter the portal
        window.location.replace('../home/home.html');

    } catch (e) {
        console.error('[Onboarding Phase 2]', e);
        msgEl.textContent = 'Error saving profile. Please try again.';
        msgEl.classList.remove('hidden');
        btn.disabled  = false;
        btn.innerHTML = `Complete Setup & Enter Portal`;
    }
});
