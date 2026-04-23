import { db } from '../../assets/js/firebase-init.js';
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { requireAuth } from '../../assets/js/auth.js';
import { injectStudentLayout } from '../../assets/js/layout-student.js';
import { showMsg } from '../../assets/js/utils.js';

// ── 1. INIT & AUTH ────────────────────────────────────────────────────────
const session = requireAuth('student', '../login.html');

// Inject layout 
injectStudentLayout('settings', 'Settings', 'Manage your profile and security');

// Update UI with session data
document.getElementById('displayStudentName').innerText = session.studentData.name || 'Student';
document.getElementById('studentAvatar').innerText = (session.studentData.name || 'S').charAt(0).toUpperCase();
document.getElementById('displayStudentClass').innerText = session.studentData.className ? `Class: ${session.studentData.className}` : 'Unassigned Class';

// State
let fullStudentData = null;

// ── 2. LOAD LATEST DATA ───────────────────────────────────────────────────
async function loadSettingsData() {
    try {
        // Fetch School Data (for Topbar)
        const schoolSnap = await getDoc(doc(db, 'schools', session.schoolId));
        if (schoolSnap.exists()) {
            document.getElementById('displaySchoolName').innerText = schoolSnap.data().schoolName;
            
            // Load active semester name for topbar consistency
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

        // Fetch latest Student Data
        const studentSnap = await getDoc(doc(db, 'schools', session.schoolId, 'students', session.studentId));
        if (studentSnap.exists()) {
            fullStudentData = studentSnap.data();
            document.getElementById('parentPhone').value = fullStudentData.parentPhone || '';
        }

    } catch (e) {
        console.error("Error loading settings:", e);
    }
}

// ── 3. UPDATE PROFILE (PHONE) ─────────────────────────────────────────────
document.getElementById('saveProfileBtn').addEventListener('click', async () => {
    const phone = document.getElementById('parentPhone').value.trim();
    const btn = document.getElementById('saveProfileBtn');
    
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    btn.disabled = true;

    try {
        await updateDoc(doc(db, 'schools', session.schoolId, 'students', session.studentId), { 
            parentPhone: phone 
        });
        fullStudentData.parentPhone = phone; // Update local state
        
        showMsg('profileMsg', 'Contact information updated successfully!', false, 'bg-emerald-50 text-emerald-700 border border-emerald-200');
    } catch (e) {
        console.error("Error updating profile:", e);
        showMsg('profileMsg', 'Failed to update profile.', true, 'bg-red-50 text-red-700 border border-red-200');
    }

    btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Details`;
    btn.disabled = false;
});

// ── 4. UPDATE SECURITY PIN ────────────────────────────────────────────────
document.getElementById('updatePinBtn').addEventListener('click', async () => {
    const curPin = document.getElementById('currentPin').value.trim();
    const newPin = document.getElementById('newPin').value.trim();
    const confirmPin = document.getElementById('confirmNewPin').value.trim();
    const msgId = 'securityMsg';
    const btn = document.getElementById('updatePinBtn');

    if (!curPin || !newPin || !confirmPin) {
        showMsg(msgId, 'All fields are required.', true, 'bg-red-50 text-red-700 border border-red-200');
        return;
    }

    // Verify current PIN (Convert both to strings to be safe against DB type mismatches)
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
        // Save as string to standardize the data type moving forward
        await updateDoc(doc(db, 'schools', session.schoolId, 'students', session.studentId), { 
            pin: String(newPin) 
        });
        
        fullStudentData.pin = String(newPin); // Update local state
        
        // Clear fields
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
