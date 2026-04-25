import { db } from '../assets/js/firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { setSessionData } from '../assets/js/auth.js';

// ── ELEMENTS ──────────────────────────────────────────────────────────────────
const loginBtn = document.getElementById('loginBtn');
const msgEl    = document.getElementById('loginMsg');

function showError(text) {
    msgEl.textContent = text;
    msgEl.classList.remove('hidden');
}

function hideError() {
    msgEl.classList.add('hidden');
}

function setLoading(loading) {
    loginBtn.disabled = loading;
    loginBtn.innerHTML = loading
        ? `<i class="fa-solid fa-spinner fa-spin"></i> Verifying...`
        : `View Progress <i class="fa-solid fa-arrow-right-to-bracket"></i>`;
}

// ── LOGIN HANDLER ─────────────────────────────────────────────────────────────
loginBtn.addEventListener('click', handleLogin);

['loginStudentId', 'loginPin'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => {
        if (e.key === 'Enter') handleLogin();
    });
});

async function handleLogin() {
    hideError();

    const rawId = document.getElementById('loginStudentId').value.trim().toUpperCase();
    const pin   = document.getElementById('loginPin').value.trim();

    if (!rawId || !pin) {
        showError('Please enter your Student ID and PIN.');
        return;
    }

    if (!/^S\d{2}-[A-Z0-9]{5}$/.test(rawId)) {
        showError('Invalid Student ID format. It should look like S26-XXXXX.');
        return;
    }

    setLoading(true);

    try {
        const studentSnap = await getDoc(doc(db, 'students', rawId));

        if (!studentSnap.exists()) {
            showError('Student ID not found. Check the ID on your credential slip.');
            setLoading(false);
            return;
        }

        const studentData = { id: studentSnap.id, ...studentSnap.data() };

        // ── Verify PIN ────────────────────────────────────────────────────
        if (String(studentData.pin) !== String(pin)) {
            showError('Incorrect PIN. Please try again.');
            setLoading(false);
            return;
        }

        // ── Save session — must happen BEFORE any gate redirect ───────────
        setSessionData('student', {
            studentId:   studentData.id,
            schoolId:    studentData.currentSchoolId || '',
            studentData: studentData
        });

        // ── Gate: Security questions not yet set ──────────────────────────
        // Triggers on first login for all students in the global system.
        // Covers both: new students and existing students who never had email
        // or security questions (they will be prompted to add them here).
        if (!studentData.securityQuestionsSet) {
            window.location.replace('../onboarding/first-time-setup.html?role=student');
            return;
        }

        // ── All gates passed — go to dashboard ────────────────────────────
        window.location.replace('home/home.html');

    } catch (e) {
        console.error('[Student Login]', e);
        showError('Connection error. Please try again.');
        setLoading(false);
    }
}
