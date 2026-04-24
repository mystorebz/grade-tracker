import { db } from '../assets/js/firebase-init.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { setSessionData } from '../assets/js/auth.js';

// ── ELEMENTS ──────────────────────────────────────────────────────────────────
const loginBtn  = document.getElementById('loginBtn');
const msgEl     = document.getElementById('loginMsg');

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

// Allow Enter key on both fields
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

    // Basic format validation
    if (!/^S\d{2}-[A-Z0-9]{5}$/.test(rawId)) {
        showError('Invalid Student ID format. It should look like S26-XXXXX.');
        return;
    }

    setLoading(true);

    try {
        // ── Look up student in global /students collection by document ID ──
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

        // ── Check enrollment status ───────────────────────────────────────
        // Students can log in regardless of status to view their academic history.
        // Only 'Active' students have a currentSchoolId to load live data from.

        // ── Save session ──────────────────────────────────────────────────
        // Include schoolId so existing student portal pages (grades, reports)
        // can still read from their siloed grade data during the transition.
        setSessionData('student', {
            studentId:   studentData.id,
            schoolId:    studentData.currentSchoolId || '',
            studentData: studentData
        });

        // ── Redirect to student home ──────────────────────────────────────
        window.location.replace('home/home.html');

    } catch (e) {
        console.error('[Student Login]', e);
        showError('Connection error. Please try again.');
        setLoading(false);
    }
}
