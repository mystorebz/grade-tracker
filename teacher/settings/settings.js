import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, updateDoc, collection, getDocs, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth, setSessionData } from '../../assets/js/auth.js';
import { injectTeacherLayout } from '../../assets/js/layout-teachers.js';

// ── 1. AUTH & LAYOUT ──────────────────────────────────────────────────────
const session = requireAuth('teacher', '../login.html');
if (session) {
    injectTeacherLayout('settings', 'Settings', 'Profile and account security', false);
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

// ── PROFILE COMPLETENESS ──────────────────────────────────────────────────
function isProfileComplete(data) {
    return !!(
        data.teacherLicenseNumber &&
        data.licenseType &&
        data.highestEducationLevel &&
        data.employmentType &&
        data.address?.city
    );
}

function updateIncompleteWarning(data) {
    const warning = document.getElementById('profileIncompleteWarning');
    if (!warning) return;
    if (isProfileComplete(data)) {
        warning.classList.add('hidden');
    } else {
        warning.classList.remove('hidden');
    }
}

// ── 2. LOAD PROFILE & SEMESTERS ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (!session) return;

    // Load Semesters to fix the "Period Loading..." bug
    await loadSemesters();

    const t = session.teacherData || {};

    // Populate header
    document.getElementById('profileAvatar').textContent      = (t.name || 'T').charAt(0).toUpperCase();
    document.getElementById('profileDisplayName').textContent = t.name  || '—';
    document.getElementById('profileTeacherId').textContent = session.teacherId || '—';

    // Populate read-only profile card display
    document.getElementById('displayName').textContent  = t.name  || '—';
    document.getElementById('displayEmail').textContent = t.email || '—';
    document.getElementById('displayPhone').textContent = t.phone || '—';

    // Populate modal basic fields
    document.getElementById('settingName').value  = t.name  || '';
    document.getElementById('settingEmail').value = t.email || '';
    document.getElementById('settingPhone').value = t.phone || '';

    // ── Fetch full teacher doc from Firestore ──────────────────────────────
    try {
        const snap = await getDoc(doc(db, 'teachers', session.teacherId));
        if (snap.exists()) {
            const data  = snap.data();
            const badge = document.getElementById('secQBadge');

            // ── Security questions badge & read-only display ───────────────
            if (data.securityQuestionsSet) {
                if (badge) {
                    badge.textContent = '✓ Set';
                    badge.className   = 'ml-auto text-[10px] font-black px-2.5 py-1 rounded-sm uppercase tracking-wider bg-green-100 text-green-700 border border-green-200';
                }
                // Pre-fill modal selects with current questions
                if (data.securityQ1 && document.getElementById('secQ1')) document.getElementById('secQ1').value = data.securityQ1;
                if (data.securityQ2 && document.getElementById('secQ2')) document.getElementById('secQ2').value = data.securityQ2;
                // Update card read-only display
                if (data.securityQ1) document.getElementById('displaySecQ1').textContent = data.securityQ1;
                if (data.securityQ2) document.getElementById('displaySecQ2').textContent = data.securityQ2;
            } else {
                if (badge) {
                    badge.textContent = '⚠ Not Set';
                    badge.className   = 'ml-auto text-[10px] font-black px-2.5 py-1 rounded-sm uppercase tracking-wider bg-amber-100 text-amber-700 border border-amber-200';
                }
            }

            // ── Populate professional modal fields ─────────────────────────
            const setVal = (id, val) => {
                const el = document.getElementById(id);
                if (el && val != null && val !== '') el.value = val;
            };

            setVal('profLicenseNumber',   data.teacherLicenseNumber);
            setVal('profLicenseType',     data.licenseType);
            setVal('profLicenseExpiry',   data.licenseExpiryDate);
            setVal('profYearsExperience', data.yearsOfExperience);
            setVal('profEmploymentType',  data.employmentType);
            setVal('profGradeLevel',      data.gradeLevelSpec);
            setVal('profEducationLevel',  data.highestEducationLevel);
            setVal('profFieldOfStudy',    data.fieldOfStudy);
            setVal('profInstitution',     data.institution);
            setVal('profYearGraduated',   data.yearGraduated);

            // Address fields
            const addr = data.address || {};
            setVal('profAddressLine1',    addr.line1);
            setVal('profAddressLine2',    addr.line2);
            setVal('profAddressCity',     addr.city);
            setVal('profAddressDistrict', addr.district);
            setVal('profAddressCountry',  addr.country || 'Belize');

            // ── Show/hide profile incomplete warning ───────────────────────
            updateIncompleteWarning(data);
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

        let activeId   = '';
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

// ── 3. SAVE PROFILE (basic + professional, all-in-one) ───────────────────
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

    // Read all professional fields from modal
    const yearsRaw = document.getElementById('profYearsExperience').value;
    const yearGradRaw = document.getElementById('profYearGraduated').value;

    const profData = {
        teacherLicenseNumber:  document.getElementById('profLicenseNumber').value.trim(),
        licenseType:           document.getElementById('profLicenseType').value,
        licenseExpiryDate:     document.getElementById('profLicenseExpiry').value,
        yearsOfExperience:     yearsRaw !== '' ? Number(yearsRaw) : null,
        employmentType:        document.getElementById('profEmploymentType').value,
        gradeLevelSpec:        document.getElementById('profGradeLevel').value,
        highestEducationLevel: document.getElementById('profEducationLevel').value,
        fieldOfStudy:          document.getElementById('profFieldOfStudy').value.trim(),
        institution:           document.getElementById('profInstitution').value.trim(),
        yearGraduated:         yearGradRaw !== '' ? Number(yearGradRaw) : null,
        address: {
            line1:    document.getElementById('profAddressLine1').value.trim(),
            line2:    document.getElementById('profAddressLine2').value.trim(),
            city:     document.getElementById('profAddressCity').value.trim(),
            district: document.getElementById('profAddressDistrict').value,
            country:  document.getElementById('profAddressCountry').value.trim() || 'Belize',
        }
    };

    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Saving...';

    try {
        const currentEmail = (session.teacherData.email || '').toLowerCase().trim();
        const newEmail     = email.toLowerCase().trim();
        const batch        = writeBatch(db);

        // ── Email change logic ──────────────────────────────────────────────
        if (newEmail !== currentEmail) {
            const regSnap = await getDoc(doc(db, 'registered_emails', newEmail));
            if (regSnap.exists()) {
                showMsg('profileMsg', 'This email is already registered to another account.', true);
                btn.disabled  = false;
                btn.innerHTML = '<i class="fa-solid fa-floppy-disk text-[11px]"></i> Save';
                return;
            }
            batch.set(doc(db, 'registered_emails', newEmail), {
                email:       newEmail,
                name:        name,
                role:        'teacher',
                referenceId: session.teacherId,
                createdAt:   new Date().toISOString()
            });
            if (currentEmail) {
                batch.delete(doc(db, 'registered_emails', currentEmail));
            }
        }

        // ── Write basic + professional together in one shot ─────────────────
        batch.update(doc(db, 'teachers', session.teacherId), {
            name, email, phone,
            ...profData
        });

        await batch.commit();

        // ── Update session ──────────────────────────────────────────────────
        session.teacherData.name  = name;
        session.teacherData.email = email;
        session.teacherData.phone = phone;
        Object.assign(session.teacherData, profData);
        setSessionData('teacher', session);

        // ── Update header & read-only card display ──────────────────────────
        document.getElementById('profileAvatar').textContent      = name.charAt(0).toUpperCase();
        document.getElementById('profileDisplayName').textContent = name;
        document.getElementById('displayName').textContent        = name;
        document.getElementById('displayEmail').textContent       = email;
        document.getElementById('displayPhone').textContent       = phone || '—';

        // ── Refresh incomplete warning ──────────────────────────────────────
        updateIncompleteWarning({ ...session.teacherData, ...profData });

        showMsg('profileMsg', 'Profile saved successfully!', false);

        // Close modal after user sees the success message
        setTimeout(() => window.closeProfileModal(), 1800);

    } catch (e) {
        console.error('[TeacherSettings] Save profile error:', e);
        showMsg('profileMsg', 'Failed to save profile. Please try again.', true);
    }

    btn.disabled  = false;
    btn.innerHTML = '<i class="fa-solid fa-floppy-disk text-[11px]"></i> Save';
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
            btn.disabled  = false;
            btn.innerHTML = '<i class="fa-solid fa-lock text-[11px]"></i> Update PIN';
            return;
        }

        await updateDoc(doc(db, 'teachers', session.teacherId), {
            pin:            nw,
            lastPinResetAt: new Date().toISOString()
        });

        ['currentPin', 'newPin', 'confirmPin'].forEach(id => document.getElementById(id).value = '');
        showMsg('pinMsg', 'PIN updated successfully!', false);
        setTimeout(() => window.closeChangePinModal(), 1800);

    } catch (e) { showMsg('pinMsg', 'Failed to update PIN. Please try again.', true); }

    btn.disabled  = false;
    btn.innerHTML = '<i class="fa-solid fa-lock text-[11px]"></i> Update PIN';
});

// ── 5. SAVE SECURITY QUESTIONS ────────────────────────────────────────────
document.getElementById('saveSecQBtn')?.addEventListener('click', async () => {
    const currentPin = document.getElementById('secQCurrentPin').value.trim();
    const q1         = document.getElementById('secQ1').value;
    const a1         = document.getElementById('secA1').value.trim();
    const q2         = document.getElementById('secQ2').value;
    const a2         = document.getElementById('secA2').value.trim();
    const btn        = document.getElementById('saveSecQBtn');

    if (!currentPin) { showMsg('secQMsg', 'Enter your current PIN to confirm your identity.', true); return; }
    if (!q1 || !a1)  { showMsg('secQMsg', 'Please select and answer Security Question 1.', true);    return; }
    if (!q2 || !a2)  { showMsg('secQMsg', 'Please select and answer Security Question 2.', true);    return; }
    if (q1 === q2)   { showMsg('secQMsg', 'Please choose two different questions.', true);             return; }

    btn.disabled  = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Saving...';

    try {
        const snap = await getDoc(doc(db, 'teachers', session.teacherId));
        if (!snap.exists() || String(snap.data().pin) !== String(currentPin)) {
            showMsg('secQMsg', 'Current PIN is incorrect.', true);
            btn.disabled  = false;
            btn.innerHTML = '<i class="fa-solid fa-floppy-disk text-[11px]"></i> Save Questions';
            return;
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

        // Update badge
        const badge = document.getElementById('secQBadge');
        if (badge) {
            badge.textContent = '✓ Set';
            badge.className   = 'ml-auto text-[10px] font-black px-2.5 py-1 rounded-sm uppercase tracking-wider bg-green-100 text-green-700 border border-green-200';
        }

        // Update card read-only display
        const dq1 = document.getElementById('displaySecQ1');
        const dq2 = document.getElementById('displaySecQ2');
        if (dq1) dq1.textContent = q1;
        if (dq2) dq2.textContent = q2;

        // Clear sensitive inputs
        document.getElementById('secQCurrentPin').value = '';
        document.getElementById('secA1').value          = '';
        document.getElementById('secA2').value          = '';

        showMsg('secQMsg', 'Security questions updated successfully!', false);
        setTimeout(() => window.closeSecurityQModal(), 1800);

    } catch (e) { showMsg('secQMsg', 'Failed to save security questions.', true); }

    btn.disabled  = false;
    btn.innerHTML = '<i class="fa-solid fa-floppy-disk text-[11px]"></i> Save Questions';
});
