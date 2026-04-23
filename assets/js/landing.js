import { db } from './firebase-init.js';
import { collection, addDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ── NAVBAR SCROLL EFFECT ──
const nav = document.getElementById('navbar');
if (nav) {
    window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 20));
}

// ── QUOTE FORM LOGIC ──
const registerBtn = document.getElementById('registerBtn');

if (registerBtn) {
    registerBtn.addEventListener('click', async () => {
        const msgEl = document.getElementById('regMessage');

        // Collect all fields
        const firstName      = document.getElementById('firstName').value.trim();
        const lastName       = document.getElementById('lastName').value.trim();
        const jobTitle       = document.getElementById('jobTitle').value.trim();
        const workEmail      = document.getElementById('workEmail').value.trim();
        const phone          = document.getElementById('phone').value.trim();
        const schoolName     = document.getElementById('schoolName').value.trim();
        const schoolType     = document.getElementById('schoolType').value;
        const country        = document.getElementById('country').value.trim();
        const city           = document.getElementById('city').value.trim();
        const stateProvince  = document.getElementById('stateProvince').value.trim();
        const studentsCount  = document.getElementById('studentsCount').value.trim();
        const teachersCount  = document.getElementById('teachersCount').value.trim();
        const hearAboutUs    = document.getElementById('hearAboutUs').value;
        const message        = document.getElementById('message').value.trim();

        // Validation
        if (!firstName || !lastName || !jobTitle || !workEmail || !phone ||
            !schoolName || !schoolType || !country || !city || !studentsCount || !teachersCount) {
            msgEl.textContent = "Please fill in all required fields (*).";
            msgEl.className = "text-sm text-center font-bold mt-2 text-red-600 block";
            return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(workEmail)) {
            msgEl.textContent = "Please enter a valid email address.";
            msgEl.className = "text-sm text-center font-bold mt-2 text-red-600 block";
            return;
        }

        btnLoadingState(true);

        const timestamp = new Date().toISOString();
        const fullName = `${firstName} ${lastName}`;

        try {
            // ── Write 1: quoteRequests collection ──
            await addDoc(collection(db, 'quoteRequests'), {
                firstName,
                lastName,
                fullName,
                jobTitle,
                workEmail,
                phone,
                schoolName,
                schoolType,
                country,
                city,
                stateProvince,
                studentsCount: parseInt(studentsCount),
                teachersCount: parseInt(teachersCount),
                hearAboutUs,
                message,
                status: 'new',
                createdAt: timestamp,
            });

            // ── Write 2: mail collection (triggers Firebase Email Extension) ──
            // Email 1: Confirmation to the contact
            await addDoc(collection(db, 'mail'), {
                to: workEmail,
                message: {
                    subject: 'We received your ConnectUs quote request!',
                    html: `
                        <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;color:#1e293b;">
                            <img src="https://connectusonline.org/assets/images/logo.png" alt="ConnectUs" style="height:60px;margin-bottom:24px;">
                            <h2 style="font-size:22px;font-weight:900;color:#1e3a8a;margin-bottom:8px;">Thank you, ${firstName}!</h2>
                            <p style="font-size:15px;color:#475569;line-height:1.6;">We've received your quote request for <strong>${schoolName}</strong> and our team is reviewing your details.</p>
                            <p style="font-size:15px;color:#475569;line-height:1.6;">You can expect to hear back from us within <strong>24–48 hours</strong> with a custom quote tailored to your school's needs.</p>
                            <div style="background:#f0f5ff;border:1px solid #dbeafe;border-radius:12px;padding:20px;margin:24px 0;">
                                <p style="font-size:13px;font-weight:700;color:#1e3a8a;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Your Submitted Details</p>
                                <table style="width:100%;font-size:14px;color:#334155;border-collapse:collapse;">
                                    <tr><td style="padding:6px 0;font-weight:700;width:40%;">Name</td><td>${fullName}</td></tr>
                                    <tr><td style="padding:6px 0;font-weight:700;">Title</td><td>${jobTitle}</td></tr>
                                    <tr><td style="padding:6px 0;font-weight:700;">School</td><td>${schoolName}</td></tr>
                                    <tr><td style="padding:6px 0;font-weight:700;">Type</td><td>${schoolType}</td></tr>
                                    <tr><td style="padding:6px 0;font-weight:700;">Location</td><td>${city}, ${country}</td></tr>
                                    <tr><td style="padding:6px 0;font-weight:700;">Students</td><td>${studentsCount}</td></tr>
                                    <tr><td style="padding:6px 0;font-weight:700;">Teachers</td><td>${teachersCount}</td></tr>
                                </table>
                            </div>
                            <p style="font-size:14px;color:#64748b;">If you have any urgent questions in the meantime, feel free to reply to this email.</p>
                            <p style="font-size:14px;color:#64748b;margin-top:32px;">Warm regards,<br><strong style="color:#1e3a8a;">The ConnectUs Team</strong></p>
                            <hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0;">
                            <p style="font-size:11px;color:#94a3b8;text-align:center;">© 2026 ConnectUs · Powered by Kismet Code Digital</p>
                        </div>
                    `,
                },
            });

            // Email 2: Notification to ConnectUs team
            await addDoc(collection(db, 'mail'), {
                to: 'info@connectusonline.org',
                message: {
                    subject: `New Quote Request — ${schoolName} (${country})`,
                    html: `
                        <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;color:#1e293b;">
                            <h2 style="font-size:20px;font-weight:900;color:#1e3a8a;margin-bottom:4px;">New Quote Request Received</h2>
                            <p style="font-size:13px;color:#64748b;margin-bottom:24px;">Submitted on ${new Date().toLocaleString()}</p>
                            <table style="width:100%;font-size:14px;color:#334155;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                                <tr style="background:#f8fafc;"><td style="padding:10px 16px;font-weight:700;border-bottom:1px solid #e2e8f0;width:35%;">Full Name</td><td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;">${fullName}</td></tr>
                                <tr><td style="padding:10px 16px;font-weight:700;border-bottom:1px solid #e2e8f0;">Job Title</td><td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;">${jobTitle}</td></tr>
                                <tr style="background:#f8fafc;"><td style="padding:10px 16px;font-weight:700;border-bottom:1px solid #e2e8f0;">Email</td><td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;"><a href="mailto:${workEmail}">${workEmail}</a></td></tr>
                                <tr><td style="padding:10px 16px;font-weight:700;border-bottom:1px solid #e2e8f0;">Phone</td><td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;">${phone}</td></tr>
                                <tr style="background:#f8fafc;"><td style="padding:10px 16px;font-weight:700;border-bottom:1px solid #e2e8f0;">School Name</td><td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;">${schoolName}</td></tr>
                                <tr><td style="padding:10px 16px;font-weight:700;border-bottom:1px solid #e2e8f0;">School Type</td><td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;">${schoolType}</td></tr>
                                <tr style="background:#f8fafc;"><td style="padding:10px 16px;font-weight:700;border-bottom:1px solid #e2e8f0;">Country</td><td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;">${country}</td></tr>
                                <tr><td style="padding:10px 16px;font-weight:700;border-bottom:1px solid #e2e8f0;">City</td><td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;">${city}</td></tr>
                                <tr style="background:#f8fafc;"><td style="padding:10px 16px;font-weight:700;border-bottom:1px solid #e2e8f0;">State/Province</td><td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;">${stateProvince || '—'}</td></tr>
                                <tr><td style="padding:10px 16px;font-weight:700;border-bottom:1px solid #e2e8f0;">Est. Students</td><td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;">${studentsCount}</td></tr>
                                <tr style="background:#f8fafc;"><td style="padding:10px 16px;font-weight:700;border-bottom:1px solid #e2e8f0;">Est. Teachers</td><td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;">${teachersCount}</td></tr>
                                <tr><td style="padding:10px 16px;font-weight:700;border-bottom:1px solid #e2e8f0;">Heard About Us</td><td style="padding:10px 16px;border-bottom:1px solid #e2e8f0;">${hearAboutUs || '—'}</td></tr>
                                <tr style="background:#f8fafc;"><td style="padding:10px 16px;font-weight:700;">Message</td><td style="padding:10px 16px;">${message || '—'}</td></tr>
                            </table>
                        </div>
                    `,
                },
            });

            // Show success screen
            document.getElementById('registrationFormContainer').classList.add('hidden');
            document.getElementById('successScreen').classList.remove('hidden');

        } catch (error) {
            console.error("Quote submission error:", error);
            msgEl.textContent = "Error submitting your request. Please try again.";
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
        btn.textContent = "Submitting...";
        btn.classList.add("opacity-75", "cursor-not-allowed");
        msgEl.textContent = "Sending your request...";
        msgEl.className = "text-sm text-center font-bold mt-2 text-blue-600 block";
    } else {
        btn.disabled = false;
        btn.textContent = "Request Quote & Setup →";
        btn.classList.remove("opacity-75", "cursor-not-allowed");
    }
}
