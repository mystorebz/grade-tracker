import { db } from './firebase-init.js';
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ── 1. NAVBAR SCROLL EFFECT ──
const nav = document.getElementById('navbar');
if (nav) {
    window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 20));
}

// ── 2. REGISTRATION FORM LOGIC ──
const registerBtn = document.getElementById('registerBtn');

if (registerBtn) {
    registerBtn.addEventListener('click', async () => {
        const msgEl = document.getElementById('regMessage');

        // Collect all fields
        const schoolName    = document.getElementById('schoolName').value.trim();
        const schoolType    = document.getElementById('schoolType').value;
        const district      = document.getElementById('district').value;
        const schoolAddress = document.getElementById('schoolAddress').value.trim();
        const contactName   = document.getElementById('contactName').value.trim();
        const phone         = document.getElementById('phone').value.trim();
        const adminEmail    = document.getElementById('adminEmail').value.trim();
        const studentsCountVal = document.getElementById('studentsCount').value.trim();
        const teachersCountVal = document.getElementById('teachersCount').value.trim();

        // Validation
        if (!schoolName || !schoolType || !district || !schoolAddress ||
            !contactName || !phone || !adminEmail || !studentsCountVal || !teachersCountVal) {
            msgEl.textContent = "Please fill in all required fields (*).";
            msgEl.className = "text-sm text-center font-bold mt-2 text-red-600 block";
            return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
            msgEl.textContent = "Please enter a valid email address.";
            msgEl.className = "text-sm text-center font-bold mt-2 text-red-600 block";
            return;
        }

        btnLoadingState(true);

        // Parse the numbers
        const studentsCount = parseInt(studentsCountVal);
        const teachersCount = parseInt(teachersCountVal);

        // Auto-assign plan
        let assignedPlan = "starter"; // Default (up to 50)
        if (studentsCount > 500) {
            assignedPlan = "enterprise";
        } else if (studentsCount > 150) {
            assignedPlan = "pro";
        } else if (studentsCount > 50) {
            assignedPlan = "growth";
        }

        // Generate School ID  e.g. "Valley High School" → "VH4823"
        const words = schoolName.split(/\s+/);
        const initials = words.length === 1
            ? words[0].substring(0, 2).toUpperCase()
            : (words[0][0] + words[1][0]).toUpperCase();
        const randomDigits = Math.floor(1000 + Math.random() * 9000);
        const schoolId = `${initials}${randomDigits}`;

        try {
            await setDoc(doc(db, "schools", schoolId), {
                schoolId,
                schoolName,
                schoolType,
                district,
                schoolAddress,
                contactName,
                phone,
                adminEmail,
                studentsCount,
                teachersCount,
                subscriptionPlan: assignedPlan,
                logoUrl: "",
                isVerified: false,
                adminCode: "ADMIN2024",
                requiresPinReset: true,
                activeSemesterId: "",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });

            // Show success with the School ID prominently displayed
            document.getElementById('generatedSchoolId').textContent = schoolId;
            document.getElementById('registrationFormContainer').classList.add('hidden');
            document.getElementById('successScreen').classList.remove('hidden');

        } catch (error) {
            console.error("Registration error:", error);
            msgEl.textContent = "Error saving your request. Please try again.";
            msgEl.className = "text-sm text-center font-bold mt-2 text-red-600 block";
            btnLoadingState(false);
        }
    });
}

function btnLoadingState(isLoading) {
    const btn = document.getElementById('registerBtn');
    const msgEl = document.getElementById('regMessage');
    
    if (isLoading) {
        btn.disabled = true;
        btn.textContent = "Submitting Request...";
        btn.classList.add("opacity-75", "cursor-not-allowed");
        msgEl.textContent = "Saving your details...";
        msgEl.className = "text-sm text-center font-bold mt-2 text-blue-600 block";
    } else {
        btn.disabled = false;
        btn.textContent = "Request Quote & Setup →";
        btn.classList.remove("opacity-75", "cursor-not-allowed");
    }
}
