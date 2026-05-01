import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { showMsg } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('student', '../login.html');

// Inject layout 
injectStudentLayout('settings', 'Settings', 'Manage your personal profile and account security');

// State
let fullStudentData = null;

// Helper to lock/unlock the profile fields via JS
function toggleProfileEditMode(isEditing) {
    const profileInputs = ['sName', 'sEmail', 'sDob', 'sParentName', 'sParentPhone'];
    const btn = document.getElementById('saveProfileBtn');

    profileInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.readOnly = !isEditing;
            if (!isEditing) {
                // Locked state visuals
                el.classList.add('opacity-70', 'cursor-not-allowed', 'bg-slate-100');
                el.classList.remove('bg-slate-50');
            } else {
                // Editable state visuals
                el.classList.remove('opacity-70', 'cursor-not-allowed', 'bg-slate-100');
                el.classList.add('bg-slate-50');
            }
        }
    });

    if (isEditing) {
        btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Profile Details`;
        btn.dataset.mode = 'save';
    } else {
        btn.innerHTML = `<i class="fa-solid fa-pen"></i> Edit Profile Details`;
        btn.dataset.mode = 'edit';
    }
}

// ── 2. LOAD LATEST DATA ───────────────────────────────────────────────────
async function loadSettingsData() {
    try {
        // Fetch School Data (for Topbar)
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolSnap.exists()) {
            const elSchool = document.getElementById('displaySchoolName');
            if(elSchool) elSchool.innerText = schoolSnap.data().schoolName;
            
            const activeSemId = schoolSnap.data().activeSemesterId;
            if (activeSemId) {
                const semSnap = await getDoc(doc(db, 'schools', session.schoolId, 'semesters', activeSemId));
                if (semSnap.exists()) {
                    document.getElementById('activeSemesterDisplay').textContent = semSnap.data().name;
                }
            } else {
                document.getElementById('activeSemesterDisplay').textContent = 'Not Set';
            }
        }

        // Fetch latest Student Data globally and populate the fields
        const studentSnap = await getDoc(doc(db, 'students', session.studentId));
        if (studentSnap.exists()) {
            fullStudentData = studentSnap.data();
            
            // Populate Profile Details with existing database values
            document.getElementById('sName').value = fullStudentData.name || '';
            document.getElementById('sEmail').value = fullStudentData.email || '';
            document.getElementById('sDob').value = fullStudentData.dob || '';
            document.getElementById('sParentName').value = fullStudentData.parentName || '';
            document.getElementById('sParentPhone').value = fullStudentData.parentPhone || '';

            // Lock the fields and turn the button into an "Edit" button by default
            toggleProfileEditMode(false);

            // Populate Security Questions if they exist
            document.getElementById('secQ1').value = fullStudentData.securityQ1 || '';
            document.getElementById('secA1').value = fullStudentData.securityA1 ? '********' : ''; // Mask existing answer
            document.getElementById('secQ2').value = fullStudentData.securityQ2 || '';
            document.getElementById('secA2').value = fullStudentData.securityA2 ? '********' : '';
        }

    } catch (e) {
        console.error("Error loading settings:", e);
    }
}

// ── 3. UPDATE PROFILE DETAILS ─────────────────────────────────────────────
document.getElementById('saveProfileBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;

    // If currently in "Edit" mode, clicking it just unlocks the fields
    if (btn.dataset.mode === 'edit') {
        toggleProfileEditMode(true);
        return;
    }
    
    // If in "Save" mode, process the update
    const name = document.getElementById('sName').value.trim();
    const email = document.getElementById('sEmail').value.trim();
    const dob = document.getElementById('sDob').value.trim();
    const parentName = document.getElementById('sParentName').value.trim();
    const parentPhone = document.getElementById('sParentPhone').value.trim();
    
    if (!name) {
        showMsg('profileMsg', 'Student Name is required.', true, 'bg-red-50 text-red-700 border border-red-200');
        return;
    }

    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;

    try {
        await updateDoc(doc(db, 'students', session.studentId), { 
            name, email, dob, parentName, parentPhone 
        });
        
        // Update local state
        fullStudentData.name = name;
        fullStudentData.email = email;
        fullStudentData.dob = dob;
        fullStudentData.parentName = parentName;
        fullStudentData.parentPhone = parentPhone;
        
        // Instantly update the sidebar UI without requiring a reload
        const elName = document.getElementById('displayStudentName');
        const elAvatar = document.getElementById('studentAvatar');
        if (elName) elName.innerText = name;
        if (elAvatar) elAvatar.innerText = name.charAt(0).toUpperCase();

        showMsg('profileMsg', 'Profile updated successfully!', false, 'bg-emerald-50 text-emerald-700 border border-emerald-200');
        
        // Lock the fields back down
        toggleProfileEditMode(false);
    } catch (e) {
        console.error("Error updating profile:", e);
        showMsg('profileMsg', 'Failed to update profile.', true, 'bg-red-50 text-red-700 border border-red-200');
        btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Profile Details`;
    }

    btn.disabled = false;
});

// ── 4. UPDATE SECURITY QUESTIONS ──────────────────────────────────────────
document.getElementById('saveSecurityBtn').addEventListener('click', async () => {
    const q1 = document.getElementById('secQ1').value.trim();
    const a1 = document.getElementById('secA1').value.trim();
    const q2 = document.getElementById('secQ2').value.trim();
    const a2 = document.getElementById('secA2').value.trim();
    
    const btn = document.getElementById('saveSecurityBtn');
    const msgId = 'securityQuestionsMsg';

    if (!q1 || !a1 || !q2 || !a2) {
        showMsg(msgId, 'All security question and answer fields are required.', true, 'bg-red-50 text-red-700 border border-red-200');
        return;
    }

    // Prevent saving literal asterisks if they just clicked save without updating the masked answer
    const finalA1 = a1 === '********' ? fullStudentData.securityA1 : a1;
    const finalA2 = a2 === '********' ? fullStudentData.securityA2 : a2;

    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;

    try {
        await updateDoc(doc(db, 'students', session.studentId), { 
            securityQ1: q1, 
            securityA1: finalA1, 
            securityQ2: q2, 
            securityA2: finalA2,
            securityQuestionsSet: true
        });
        
        fullStudentData.securityQ1 = q1;
        fullStudentData.securityA1 = finalA1;
        fullStudentData.securityQ2 = q2;
        fullStudentData.securityA2 = finalA2;

        showMsg(msgId, 'Security questions updated successfully!', false, 'bg-emerald-50 text-emerald-700 border border-emerald-200');
    } catch (e) {
        console.error("Error updating security questions:", e);
        showMsg(msgId, 'Failed to update security questions.', true, 'bg-red-50 text-red-700 border border-red-200');
    }

    btn.innerHTML = `<i class="fa-solid fa-shield-check"></i> Save Security Questions`;
    btn.disabled = false;
});

// ── 5. UPDATE SECURITY PIN ────────────────────────────────────────────────
document.getElementById('updatePinBtn').addEventListener('click', async () => {
    const curPin = document.getElementById('currentPin').value.trim();
    const newPin = document.getElementById('newPin').value.trim();
    const confirmPin = document.getElementById('confirmNewPin').value.trim();
    const msgId = 'securityMsg';
    const btn = document.getElementById('updatePinBtn');

    if (!curPin || !newPin || !confirmPin) {
        showMsg(msgId, 'All PIN fields are required.', true, 'bg-red-50 text-red-700 border border-red-200');
        return;
    }

    if (String(curPin) !== String(fullStudentData.pin)) {
        showMsg(msgId, 'Current PIN is incorrect.', true, 'bg-red-50 text-red-700 border border-red-200');
        return;
    }

    if (newPin !== confirmPin) {
        showMsg(msgId, 'New PINs do not match.', true, 'bg-red-50 text-red-700 border border-red-200');
        return;
    }

    if (newPin.length < 4) {
        showMsg(msgId, 'PIN must be at least 4 digits.', true, 'bg-red-50 text-red-700 border border-red-200');
        return;
    }

    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Updating...`;
    btn.disabled = true;

    try {
        await updateDoc(doc(db, 'students', session.studentId), { pin: String(newPin) });
        fullStudentData.pin = String(newPin);
        
        document.getElementById('currentPin').value = '';
        document.getElementById('newPin').value = '';
        document.getElementById('confirmNewPin').value = '';
        
        showMsg(msgId, 'Security PIN updated successfully!', false, 'bg-emerald-50 text-emerald-700 border border-emerald-200');
    } catch (e) {
        console.error("Error updating PIN:", e);
        showMsg(msgId, 'Failed to update PIN.', true, 'bg-red-50 text-red-700 border border-red-200');
    }

    btn.innerHTML = `<i class="fa-solid fa-lock"></i> Update Security PIN`;
    btn.disabled = false;
});

// ── INITIALIZE ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadSettingsData);
