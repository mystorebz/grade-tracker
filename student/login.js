import { db, auth } from '../assets/js/firebase-init.js';
import { doc, getDoc }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { signInWithCustomToken }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFunctions, httpsCallable }
    from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { setSessionData } from '../assets/js/auth.js';

// ── Functions instance ────────────────────────────────────────────────────────
const functions        = getFunctions();
const mintStudentToken = httpsCallable(functions, 'mintStudentToken');

// ── Elements ──────────────────────────────────────────────────────────────────
const loginBtn = document.getElementById('loginBtn');
const msgEl    = document.getElementById('loginMsg');

function showError(text) { msgEl.textContent = text; msgEl.classList.add('show');    }
function hideError()     {                            msgEl.classList.remove('show'); }

function setLoading(loading) {
    loginBtn.disabled  = loading;
    loginBtn.innerHTML = loading
        ? `<i class="fa-solid fa-spinner fa-spin"></i> Verifying...`
        : `<i class="fa-solid fa-arrow-right-to-bracket"></i> View My Progress`;
}

// ── Login Handler ─────────────────────────────────────────────────────────────
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
        // ── Verify student exists and PIN is correct ───────────────────────────
        const studentSnap = await getDoc(doc(db, 'students', rawId));

        if (!studentSnap.exists()) {
            showError('Student ID not found. Check the ID on your credential slip.');
            setLoading(false);
            return;
        }

        const studentData = { id: studentSnap.id, ...studentSnap.data() };

        if (String(studentData.pin) !== String(pin)) {
            showError('Incorrect PIN. Please try again.');
            setLoading(false);
            return;
        }

        // ── Mint Firebase Auth token via Cloud Function ────────────────────────
        try {
            const result = await mintStudentToken({ studentId: rawId, pin });
            await signInWithCustomToken(auth, result.data.token);
        } catch (e) {
            console.error('[Student Login] mintStudentToken failed:', e);
            // Non-fatal during migration — log but continue
        }

        // ── Save session ───────────────────────────────────────────────────────
        setSessionData('student', {
            studentId:   studentData.id,
            schoolId:    studentData.currentSchoolId || '',
            studentData: studentData
        });

        // ── Gate: Security questions ───────────────────────────────────────────
        if (!studentData.securityQuestionsSet) {
            window.location.replace('../onboarding/first-time-setup.html?role=student');
            return;
        }

        window.location.replace('home/home.html');

    } catch (e) {
        console.error('[Student Login]', e);
        showError('Connection error. Please try again.');
        setLoading(false);
    }
}
