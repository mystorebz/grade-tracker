import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, updateDoc, collection, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('settings', 'Settings', 'Profile, gradebook configuration, and account security', false);
}

// ── SHA-256 ───────────────────────────────────────────────────────────────
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
        ? 'text-[12px] font-bold p-2.5 rounded-sm text-red-600 bg-red-50 border border-red-100 mt-2'
        : 'text-[12px] font-bold p-2.5 rounded-sm text-green-600 bg-green-50 border border-green-100 mt-2';
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 5000);
}

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Global state for Grade Types
let teacherGradeTypes = [];

// ── 2. LOAD PROFILE & SEMESTERS ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (!session) return;

    // Load Semesters to fix the "Period Loading..." bug
    await loadSemesters();

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
            } else if (data.customGradeTypes && Array.isArray(data.customGradeTypes)) {
                teacherGradeTypes = data.customGradeTypes; // Fallback for legacy naming
            }
            renderGradeTypes();
        }
    } catch (e) {
        console.error('[TeacherSettings] load profile data:', e);
    }
});

// ── PERIOD LOADER ─────────────────────────────────────────────────────────
async function loadSemesters() {
    try {
        const cacheKey = `connectus_semesters_${session.schoolId}`;
        const cached   = localStorage.getItem(cacheKey);
        let rawSemesters = [];

        if (cached) {
            rawSemesters = JSON.parse(cached);
        } else {
            const snap = await getDocs(collection(db, 'schools', session.schoolId, 'semesters'));
            rawSemesters = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
            localStorage.setItem(cacheKey, JSON.stringify(rawSemesters));
        }

        let activeId = '';
        let activeName = 'Period';
        try {
            const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
            activeId = schoolSnap.data()?.activeSemesterId || '';
            const activeSem = rawSemesters.find(s => s.id === activeId);
            if (activeSem) activeName = activeSem.name;
        } catch(e) {}

        const activeSemesterSelect = document.getElementById('activeSemester');
        if (activeSemesterSelect) {
            activeSemesterSelect.innerHTML = '';
            rawSemesters.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id; opt.textContent = s.name;
                if (s.id === activeId) opt.selected = true;
                activeSemesterSelect.appendChild(opt);
            });
        }

        const sbPeriod = document.getElementById('sb-period');
        if (sbPeriod) sbPeriod.textContent = activeName;
    } catch (e) { console.error('[TeacherSettings] loadSemesters:', e); }
}

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
        session.teacherData.name  = name;
        session.teacherData.email = email;
        session.teacherData.phone = phone;
        setSessionData('teacher', session);

        document.getElementById('profileAvatar').textContent      = name.charAt(0).toUpperCase();
        document.getElementById('profileDisplayName').textContent = name;

        showMsg('profileMsg', 'Profile saved successfully!', false);
    } catch (e) { showMsg('profileMsg', 'Failed to save profile. Please try again.', true); }

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
        const snap = await getDoc(doc(db, 'teachers', session.teacherId));
        if (!snap.exists() || String(snap.data().pin) !== String(current)) {
            showMsg('pinMsg', 'Current PIN is incorrect.', true);
            btn.disabled  = false; btn.innerHTML = 'Update PIN'; return;
        }

        await updateDoc(doc(db, 'teachers', session.teacherId), {
            pin:             nw,
            lastPinResetAt:  new Date().toISOString()
        });

        ['currentPin','newPin','confirmPin'].forEach(id => document.getElementById(id).value = '');
        showMsg('pinMsg', 'PIN updated successfully!', false);
    } catch (e) { showMsg('pinMsg', 'Failed to update PIN. Please try again.', true); }

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
    if (q1 === q2)    { showMsg('secQMsg', 'Please choose two different questions.', true);             return; }

    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Saving...';

    try {
        const snap = await getDoc(doc(db, 'teachers', session.teacherId));
        if (!snap.exists() || String(snap.data().pin) !== String(currentPin)) {
            showMsg('secQMsg', 'Current PIN is incorrect.', true);
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

    } catch (e) { showMsg('secQMsg', 'Failed to save security questions.', true); }

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

if (gtSelect) {
    gtSelect.addEventListener('change', (e) => {
        if (e.target.value === 'Custom') {
            gtCustomName.classList.remove('hidden');
            gtCustomName.focus();
        } else {
            gtCustomName.classList.add('hidden');
            gtCustomName.value = '';
        }
    });
}

if (addGtBtn) {
    addGtBtn.addEventListener('click', () => {
        const type   = gtSelect.value;
        const name   = type === 'Custom' ? gtCustomName.value.trim() : type;
        const weight = parseInt(gtWeight.value, 10);

        if (!type) { showMsg('gtMsg', 'Please select a grade type.', true); return; }
        if (type === 'Custom' && !name) { showMsg('gtMsg', 'Please enter a custom name.', true); return; }
        if (isNaN(weight) || weight <= 0) { showMsg('gtMsg', 'Please enter a valid weight (e.g., 20).', true); return; }

        if (teacherGradeTypes.some(g => g.name.toLowerCase() === name.toLowerCase())) {
            showMsg('gtMsg', 'This grade type already exists.', true); return;
        }

        teacherGradeTypes.push({ name, weight });
        renderGradeTypes();

        gtSelect.value = '';
        if (gtCustomName) { gtCustomName.classList.add('hidden'); gtCustomName.value = ''; }
        gtWeight.value = '';
    });
}

window.removeGradeType = function(index) {
    teacherGradeTypes.splice(index, 1);
    renderGradeTypes();
};

function renderGradeTypes() {
    if (!gtList || !gtTotal) return;

    let total = 0;
    gtList.innerHTML = teacherGradeTypes.map((g, i) => {
        total += g.weight;
        return `
        <div class="flex items-center justify-between p-3 bg-white border border-[#dce3ed] rounded-sm mb-2 hover:border-[#cbd5e1] transition">
            <div class="flex items-center gap-3">
                <div class="w-6 h-6 rounded-full bg-[#f0f4f8] text-[#6b84a0] flex items-center justify-center text-[10px] font-black"><i class="fa-solid fa-tag"></i></div>
                <p class="text-[13px] font-bold text-[#0d1f35]">${escHtml(g.name)}</p>
            </div>
            <div class="flex items-center gap-4">
                <span class="text-[12px] font-black text-[#0ea871] bg-[#edfaf4] px-2 py-0.5 rounded-sm border border-[#c6f0db]">${g.weight}%</span>
                <button onclick="window.removeGradeType(${i})" class="text-[#e31b4a] hover:bg-[#fff0f3] p-1.5 rounded-sm transition" title="Remove">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        </div>`;
    }).join('');

    if (teacherGradeTypes.length === 0) {
        gtList.innerHTML = `<div class="p-6 text-center border-2 border-dashed border-[#dce3ed] rounded-sm"><p class="text-[12px] text-[#9ab0c6] font-medium">No metrics configured.<br>Add your first assessment type above.</p></div>`;
    }

    gtTotal.textContent = `Total Active Weight: ${total}%`;
    if (total === 100) {
        gtTotal.className = 'text-[12px] font-black text-[#0ea871] uppercase tracking-widest';
    } else if (total > 100) {
        gtTotal.className = 'text-[12px] font-black text-[#e31b4a] uppercase tracking-widest';
        showMsg('gtMsg', 'Warning: Total weight exceeds 100%. Math will auto-scale, but this may confuse parents.', true);
    } else {
        gtTotal.className = 'text-[12px] font-black text-[#d97706] uppercase tracking-widest';
    }
}

if (saveGtBtn) {
    saveGtBtn.addEventListener('click', async () => {
        if (teacherGradeTypes.length === 0) {
            showMsg('gtMsg', 'Please add at least one metric before saving.', true); return;
        }

        saveGtBtn.disabled = true;
        saveGtBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Saving...';

        try {
            await updateDoc(doc(db, 'teachers', session.teacherId), { gradeTypes: teacherGradeTypes });
            session.teacherData.gradeTypes = teacherGradeTypes;
            setSessionData('teacher', session);
            showMsg('gtMsg', 'Configuration committed to active gradebook!', false);
        } catch (e) { showMsg('gtMsg', 'Failed to save configuration. Please try again.', true); }

        saveGtBtn.disabled = false;
        saveGtBtn.innerHTML = '<i class="fa-solid fa-floppy-disk mr-2"></i> Save Configuration';
    });
}
