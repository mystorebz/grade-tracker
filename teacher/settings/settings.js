import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('settings', 'Settings', 'Profile, security, and account configuration', false);
}

// ── SHA-256 ───────────────────────────────────────────────────────────────
// Used for security question answers — same normalization as all other files.
// NOTE: Teacher PINs are stored plain text (no hashing) to match the
// existing teacher login comparison. When teacher login is upgraded to
// hash-compare, update both this file and teacher/login.js together.
async function sha256(text) {
    const encoded = new TextEncoder().encode(text.toLowerCase().trim());
    const buffer  = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function showMsg(elId, msg, isError) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = msg;
    el.className   = isError
        ? 'text-[12px] font-bold p-2.5 rounded-sm text-red-600 bg-red-50 border border-red-100'
        : 'text-[12px] font-bold p-2.5 rounded-sm text-green-600 bg-green-50 border border-green-100';
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 5000);
}

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Global state for Grade Types
let teacherGradeTypes = [];

// ── 2. LOAD PROFILE ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (!session) return;

    const t = session.teacherData || {};

    // Populate header
    document.getElementById('profileAvatar').textContent      = (t.name || 'T').charAt(0).toUpperCase();
    document.getElementById('profileDisplayName').textContent = t.name  || '—';
    document.getElementById('profileSchoolId').textContent    = session.schoolId || '—';

    // Populate form fields
    document.getElementById('settingName').value  = t.name  || '';
    document.getElementById('settingEmail').value = t.email || '';
    document.getElementById('settingPhone').value = t.phone || '';

    // ── Security questions status badge & Grade Types ──────────────────────
    try {
        const snap = await getDoc(doc(db, 'teachers', session.teacherId));
        if (snap.exists()) {
            const data  = snap.data();
            const badge = document.getElementById('secQBadge');
            
            // Security Questions
            if (data.securityQuestionsSet) {
                if (badge) {
                    badge.textContent = '✓ Set';
                    badge.className   = 'ml-auto text-[10px] font-black px-2.5 py-1 rounded-sm uppercase tracking-wider bg-green-100 text-green-700 border border-green-200';
                }
                // Pre-fill existing questions so teacher knows what's set
                if (data.securityQ1 && document.getElementById('secQ1')) document.getElementById('secQ1').value = data.securityQ1;
                if (data.securityQ2 && document.getElementById('secQ2')) document.getElementById('secQ2').value = data.securityQ2;
            } else {
                if (badge) {
                    badge.textContent = '⚠ Not Set';
                    badge.className   = 'ml-auto text-[10px] font-black px-2.5 py-1 rounded-sm uppercase tracking-wider bg-amber-100 text-amber-700 border border-amber-200';
                }
            }

            // Load existing Grade Types
            if (data.gradeTypes && Array.isArray(data.gradeTypes)) {
                teacherGradeTypes = data.gradeTypes;
            }
            renderGradeTypes();
        }
    } catch (e) {
        console.error('[TeacherSettings] load profile data:', e);
    }
});

// ── 3. SAVE PROFILE ───────────────────────────────────────────────────────
document.getElementById('saveProfileBtn')?.addEventListener('click', async () => {
    const name  = document.getElementById('settingName').value.trim();
    const email = document.getElementById('settingEmail').value.trim();
    const phone = document.getElementById('settingPhone').value.trim();
    const btn   = document.getElementById('saveProfileBtn');

    if (!name)  { showMsg('profileMsg', 'Name is required.', true); return; }
    if (!email) { showMsg('profileMsg', 'Email is required for PIN recovery.', true); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showMsg('profileMsg', 'Please enter a valid email address.', true); return;
    }

    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Saving...';

    try {
        await updateDoc(doc(db, 'teachers', session.teacherId), { name, email, phone });

        // Update session so sidebar reflects new name immediately
        session.teacherData.name  = name;
        session.teacherData.email = email;
        session.teacherData.phone = phone;
        setSessionData('teacher', session);

        document.getElementById('profileAvatar').textContent      = name.charAt(0).toUpperCase();
        document.getElementById('profileDisplayName').textContent = name;

        showMsg('profileMsg', 'Profile saved successfully!', false);
    } catch (e) {
        console.error('[TeacherSettings] saveProfile:', e);
        showMsg('profileMsg', 'Failed to save profile. Please try again.', true);
    }

    btn.disabled  = false;
    btn.innerHTML = 'Save Profile';
});

// ── 4. CHANGE PIN ─────────────────────────────────────────────────────────
document.getElementById('savePinBtn')?.addEventListener('click', async () => {
    const current = document.getElementById('currentPin').value.trim();
    const nw      = document.getElementById('newPin').value.trim();
    const cf      = document.getElementById('confirmPin').value.trim();
    const btn     = document.getElementById('savePinBtn');

    if (!current || !nw || !cf) { showMsg('pinMsg', 'All three fields are required.', true); return; }
    if (nw !== cf)              { showMsg('pinMsg', 'New PINs do not match.', true);         return; }
    if (nw.length < 6)          { showMsg('pinMsg', 'PIN must be at least 6 characters.', true); return; }

    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Updating...';

    try {
        // Fetch fresh teacher doc to compare current PIN
        const snap = await getDoc(doc(db, 'teachers', session.teacherId));
        if (!snap.exists() || String(snap.data().pin) !== String(current)) {
            showMsg('pinMsg', 'Current PIN is incorrect.', true);
            btn.disabled  = false; btn.innerHTML = 'Update PIN'; return;
        }

        await updateDoc(doc(db, 'teachers', session.teacherId), {
            pin:             nw,
            lastPinResetAt:  new Date().toISOString()
        });

        // Clear form
        ['currentPin','newPin','confirmPin'].forEach(id => document.getElementById(id).value = '');
        showMsg('pinMsg', 'PIN updated successfully!', false);

    } catch (e) {
        console.error('[TeacherSettings] changePin:', e);
        showMsg('pinMsg', 'Failed to update PIN. Please try again.', true);
    }

    btn.disabled  = false;
    btn.innerHTML = 'Update PIN';
});

// ── 5. SAVE SECURITY QUESTIONS ────────────────────────────────────────────
document.getElementById('saveSecQBtn')?.addEventListener('click', async () => {
    const currentPin = document.getElementById('secQCurrentPin').value.trim();
    const q1         = document.getElementById('secQ1').value;
    const a1         = document.getElementById('secA1').value.trim();
    const q2         = document.getElementById('secQ2').value;
    const a2         = document.getElementById('secA2').value.trim();
    const btn        = document.getElementById('saveSecQBtn');

    if (!currentPin)  { showMsg('secQMsg', 'Enter your current PIN to confirm your identity.', true); return; }
    if (!q1 || !a1)   { showMsg('secQMsg', 'Please select and answer Security Question 1.', true);    return; }
    if (!q2 || !a2)   { showMsg('secQMsg', 'Please select and answer Security Question 2.', true);    return; }
    if (q1 === q2)    { showMsg('secQMsg', 'Please choose two different questions.', true);            return; }

    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Saving...';

    try {
        // Verify current PIN before allowing security question change
        const snap = await getDoc(doc(db, 'teachers', session.teacherId));
        if (!snap.exists() || String(snap.data().pin) !== String(currentPin)) {
            showMsg('secQMsg', 'Current PIN is incorrect. Security questions not changed.', true);
            btn.disabled  = false; btn.innerHTML = 'Save Security Questions'; return;
        }

        const [hashedA1, hashedA2] = await Promise.all([sha256(a1), sha256(a2)]);

        await updateDoc(doc(db, 'teachers', session.teacherId), {
            securityQ1:           q1,
            securityA1:           hashedA1,
            securityQ2:           q2,
            securityA2:           hashedA2,
            securityQuestionsSet: true
        });

        // Update session and badge
        session.teacherData.securityQuestionsSet = true;
        setSessionData('teacher', session);

        const badge   = document.getElementById('secQBadge');
        if (badge) {
            badge.textContent = '✓ Set';
            badge.className   = 'ml-auto text-[10px] font-black px-2.5 py-1 rounded-sm uppercase tracking-wider bg-green-100 text-green-700 border border-green-200';
        }

        document.getElementById('secQCurrentPin').value = '';
        document.getElementById('secA1').value          = '';
        document.getElementById('secA2').value          = '';

        showMsg('secQMsg', 'Security questions updated successfully!', false);

    } catch (e) {
        console.error('[TeacherSettings] saveSecQ:', e);
        showMsg('secQMsg', 'Failed to save security questions. Please try again.', true);
    }

    btn.disabled  = false;
    btn.innerHTML = 'Save Security Questions';
});

// ── 6. GRADE TYPES MANAGEMENT ─────────────────────────────────────────────

const gtSelect     = document.getElementById('gtSelect');
const gtCustomName = document.getElementById('gtCustomName');
const gtWeight     = document.getElementById('gtWeight');
const addGtBtn     = document.getElementById('addGradeTypeBtn');
const gtList       = document.getElementById('gradeTypesList');
const gtTotal      = document.getElementById('gtTotalWeight');
const saveGtBtn    = document.getElementById('saveGradeTypesBtn');

// Handle showing/hiding custom input box
if (gtSelect) {
    gtSelect.addEventListener('change', (e) => {
        if (e.target.value === 'Custom') {
            gtCustomName.classList.remove('hidden');
        } else {
            gtCustomName.classList.add('hidden');
            gtCustomName.value = '';
        }
    });
}

// Add Grade Type to local list
if (addGtBtn) {
    addGtBtn.addEventListener('click', () => {
        const type   = gtSelect.value;
        const name   = type === 'Custom' ? gtCustomName.value.trim() : type;
        const weight = parseInt(gtWeight.value, 10);

        if (!type) { showMsg('gtMsg', 'Please select a grade type.', true); return; }
        if (type === 'Custom' && !name) { showMsg('gtMsg', 'Please enter a custom name.', true); return; }
        if (isNaN(weight) || weight <= 0) { showMsg('gtMsg', 'Please enter a valid weight (e.g., 20).', true); return; }

        // Check for duplicates
        if (teacherGradeTypes.some(g => g.name.toLowerCase() === name.toLowerCase())) {
            showMsg('gtMsg', 'This grade type already exists in your list.', true); return;
        }

        teacherGradeTypes.push({ name, weight });
        renderGradeTypes();

        // Reset inputs
        gtSelect.value = '';
        if (gtCustomName) {
            gtCustomName.classList.add('hidden');
            gtCustomName.value = '';
        }
        gtWeight.value = '';
    });
}

// Remove Grade Type from local list
window.removeGradeType = function(index) {
    teacherGradeTypes.splice(index, 1);
    renderGradeTypes();
};

// Render the UI List & Update Total
function renderGradeTypes() {
    if (!gtList || !gtTotal) return;

    let total = 0;
    gtList.innerHTML = teacherGradeTypes.map((g, i) => {
        total += g.weight;
        return `
        <div class="flex items-center justify-between p-3 bg-white border border-[#dce3ed] rounded-lg mb-2">
            <div>
                <p class="text-[13px] font-bold text-[#0d1f35]">${escHtml(g.name)}</p>
            </div>
            <div class="flex items-center gap-4">
                <span class="text-[12px] font-black text-[#2563eb] bg-[#eef4ff] px-2 py-1 rounded border border-[#c7d9fd]">${g.weight}%</span>
                <button onclick="window.removeGradeType(${i})" class="text-[#e31b4a] hover:text-red-700 transition" title="Remove">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        </div>`;
    }).join('');

    if (teacherGradeTypes.length === 0) {
        gtList.innerHTML = `<p class="text-[12px] text-[#9ab0c6] italic text-center p-4">No grade types added yet.</p>`;
    }

    // Visual Counter
    gtTotal.textContent = `Total Weight: ${total} / 100`;
    if (total === 100) {
        gtTotal.className = 'text-[12px] font-black text-green-600 bg-green-50 px-3 py-1.5 rounded border border-green-200';
    } else if (total > 100) {
        gtTotal.className = 'text-[12px] font-black text-amber-600 bg-amber-50 px-3 py-1.5 rounded border border-amber-200';
    } else {
        gtTotal.className = 'text-[12px] font-black text-[#6b84a0] bg-[#f8fafb] px-3 py-1.5 rounded border border-[#dce3ed]';
    }
}

// Save to Firebase
if (saveGtBtn) {
    saveGtBtn.addEventListener('click', async () => {
        if (teacherGradeTypes.length === 0) {
            showMsg('gtMsg', 'Please add at least one grade type before saving.', true);
            return;
        }

        saveGtBtn.disabled = true;
        saveGtBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Saving...';

        try {
            await updateDoc(doc(db, 'teachers', session.teacherId), {
                gradeTypes: teacherGradeTypes
            });

            // Update session data so other pages don't need to fetch from DB immediately
            session.teacherData.gradeTypes = teacherGradeTypes;
            setSessionData('teacher', session);

            showMsg('gtMsg', 'Grade types saved successfully!', false);
        } catch (e) {
            console.error('[TeacherSettings] saveGradeTypes:', e);
            showMsg('gtMsg', 'Failed to save grade types. Please try again.', true);
        }

        saveGtBtn.disabled = false;
        saveGtBtn.innerHTML = '<i class="fa-solid fa-floppy-disk mr-2"></i> Save Grade Types';
    });
}
