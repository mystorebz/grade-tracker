import { db } from '../../assets/js/firebase-init.js';
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';

// ── AUTH GUARD ────────────────────────────────────────────────────────────────
// Redirect to login if no valid session
const session = requireAuth('teacher', '../login.html');
if (!session) throw new Error('No session');

// ── If profile is already complete, skip straight to dashboard ────────────────
if (session.teacherData?.profileComplete === true) {
    window.location.replace('../home/home.html');
}

// ── SHOW TEACHER NAME ─────────────────────────────────────────────────────────
const nameEl = document.getElementById('welcomeTeacherName');
if (nameEl && session.teacherData?.name) {
    nameEl.textContent = `Welcome, ${session.teacherData.name}`;
}

// ── SAVE HANDLER ──────────────────────────────────────────────────────────────
document.getElementById('obSaveBtn').addEventListener('click', async () => {
    const country  = document.getElementById('obCountry').value;
    const district = document.getElementById('obDistrict').value;
    const town     = document.getElementById('obTown').value.trim();
    const years    = document.getElementById('obYears').value;
    const msgEl    = document.getElementById('obMsg');
    const btn      = document.getElementById('obSaveBtn');

    msgEl.classList.add('hidden');

    if (!country || !district) {
        msgEl.textContent = 'Country and District are required.';
        msgEl.classList.remove('hidden');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;

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

        // Update the global teacher document
        await updateDoc(doc(db, 'teachers', session.teacherId), profileData);

        // Update session so the rest of the portal sees profileComplete: true
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
        console.error('[Onboarding]', e);
        msgEl.textContent = 'Error saving profile. Please try again.';
        msgEl.classList.remove('hidden');
        btn.disabled  = false;
        btn.innerHTML = `<i class="fa-solid fa-check"></i> Complete Profile & Enter Portal`;
    }
});
